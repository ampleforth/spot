import { getAdminAddress, getImplementationAddress } from "@openzeppelin/upgrades-core";
import { task, types } from "hardhat/config";
import { TaskArguments } from "hardhat/types";

task("ops:vault:info")
  .addPositionalParam("vaultAddress", "the address of the vault contract", undefined, types.string, false)
  .setAction(async function (args: TaskArguments, hre) {
    const { vaultAddress } = args;

    const vault = await hre.ethers.getContractAt("RolloverVault", vaultAddress);
    const feePolicy = await hre.ethers.getContractAt("FeePolicy", await vault.feePolicy());
    const vaultDecimals = await vault.decimals();
    const proxyAdminAddress = await getAdminAddress(hre.ethers.provider, vaultAddress);
    const implAddress = await getImplementationAddress(hre.ethers.provider, vaultAddress);
    const vaultSupply = await vault.totalSupply();

    const perp = await hre.ethers.getContractAt("PerpetualTranche", await vault.perp());
    const perpDecimals = await perp.decimals();

    const underlying = await hre.ethers.getContractAt("MockERC20", await vault.underlying());
    const underlyingDecimals = await underlying.decimals();

    let pokeAvailable = true;
    try {
      await vault.recoverAndRedeploy.staticCall();
    } catch (e) {
      pokeAvailable = false;
    }
    console.log("---------------------------------------------------------------");
    console.log("RolloverVault:", vault.target);
    console.log("proxyAdmin:", proxyAdminAddress);
    console.log("implementation:", implAddress);
    console.log("feePolicy:", feePolicy.target);
    console.log("owner:", await vault.owner());
    console.log("paused:", await vault.paused());
    console.log("perp:", perp.target);
    console.log("underlying:", underlying.target);
    console.log("minDeploymentAmt:", hre.ethers.formatUnits(await vault.minDeploymentAmt(), underlyingDecimals));
    console.log("totalSupply:", hre.ethers.formatUnits(vaultSupply, vaultDecimals));
    console.log("pokeAvailable:", pokeAvailable);
    console.log("---------------------------------------------------------------");
    const data = [];
    const underlyingBalance = await vault.vaultAssetBalance(underlying.target);
    data.push({
      asset: await underlying.symbol(),
      balance: hre.ethers.formatUnits(underlyingBalance, underlyingDecimals),
      price: "1",
    });
    const assetCount = Number(await vault.assetCount());
    for (let i = 1; i < assetCount; i++) {
      const tokenAddress = await vault.assetAt.staticCall(i);
      const balance = await vault.vaultAssetBalance(tokenAddress);
      const value = await vault.getVaultAssetValue.staticCall(tokenAddress);
      const price = (value * 10n ** perpDecimals) / balance;

      const token = await hre.ethers.getContractAt("MockERC20", tokenAddress);
      data.push({
        asset: await token.symbol(),
        balance: hre.ethers.formatUnits(balance, underlyingDecimals),
        price: hre.ethers.formatUnits(price, perpDecimals),
      });
    }

    const perpBalance = await perp.balanceOf(vault.target);
    const perpSupply = await perp.totalSupply();
    const perpTVL = await perp.getTVL.staticCall();
    const perpPrice = perpSupply > 0n ? (perpTVL * 1000n) / perpSupply : 0n;
    data.push({
      asset: await perp.symbol(),
      balance: hre.ethers.formatUnits(perpBalance, perpDecimals),
      price: hre.ethers.formatUnits(perpPrice, 3),
    });
    console.table(data);

    console.log("---------------------------------------------------------------");
    const feeOne = await feePolicy.ONE();
    const feeDecimals = await feePolicy.decimals();
    const vaultTVL = await vault.getTVL.staticCall();
    const seniorTR = await perp.getDepositTrancheRatio.staticCall();
    const juniorTR = 1000n - seniorTR;
    const systemRatio = (vaultTVL * feeOne) / perpTVL;
    const targetSystemRatio = await feePolicy.targetSystemRatio();
    const expectedVaultTVL = (targetSystemRatio * perpTVL) / feeOne;
    const deviationRatio = await feePolicy["computeDeviationRatio((uint256,uint256))"]([perpTVL, vaultTVL]);
    console.log("perpTVL:", hre.ethers.formatUnits(perpTVL, underlyingDecimals));
    console.log("vaultTVL:", hre.ethers.formatUnits(vaultTVL, underlyingDecimals));
    console.log("expectedVaultTVL:", hre.ethers.formatUnits(expectedVaultTVL, underlyingDecimals));
    console.log("seniorTR:", hre.ethers.formatUnits(seniorTR, 3));
    console.log("juniorTR:", hre.ethers.formatUnits(juniorTR, 3));
    console.log("systemRatio:", hre.ethers.formatUnits(systemRatio, feeDecimals));
    console.log("targetSystemRatio:", hre.ethers.formatUnits(targetSystemRatio, feeDecimals));
    console.log("targetDeviationRatio:", hre.ethers.formatUnits(feeOne, feeDecimals));
    console.log("deviationRatio:", hre.ethers.formatUnits(deviationRatio, feeDecimals));

    console.log("---------------------------------------------------------------");
    console.log("feePolicy:", feePolicy.target);
    console.log("owner", await feePolicy.owner());
    console.log("---------------------------------------------------------------");
    console.log("Swap slippage");
    try {
      const buy1000Perps = await vault.computeUnderlyingToPerpSwapAmt.staticCall(
        hre.ethers.parseUnits("1000", perpDecimals),
      );
      console.log("Swap 1000 underlying for perps: ", hre.ethers.formatUnits(buy1000Perps[0], perpDecimals));
    } catch {
      console.log("Swap underlying for perps disabled");
    }
    try {
      const sell1000Perps = await vault.computePerpToUnderlyingSwapAmt.staticCall(
        hre.ethers.parseUnits("1000", perpDecimals),
      );
      console.log("PerpPrice:", hre.ethers.formatUnits(perpPrice, 3));
      console.log("Sell 1000 perps for underlying", hre.ethers.formatUnits(sell1000Perps[0], perpDecimals));
    } catch {
      console.log("Swap perps for underlying disabled");
    }
    console.log("---------------------------------------------------------------");
  });

task("ops:vault:deposit")
  .addParam("vaultAddress", "the address of the vault contract", undefined, types.string, false)
  .addParam(
    "underlyingAmount",
    "the total amount of underlying tokens (in float) to deposit",
    undefined,
    types.string,
    false,
  )
  .addParam("fromIdx", "the index of sender", 0, types.int)
  .setAction(async function (args: TaskArguments, hre) {
    const { vaultAddress, underlyingAmount } = args;

    const vault = await hre.ethers.getContractAt("RolloverVault", vaultAddress);
    const underlying = await hre.ethers.getContractAt("MockERC20", await vault.underlying());
    const fixedPtAmount = hre.ethers.parseUnits(underlyingAmount, await underlying.decimals());

    const signer = (await hre.ethers.getSigners())[args.fromIdx];
    const signerAddress = await signer.getAddress();
    console.log("Signer", signerAddress);

    console.log(
      "Signer note balance",
      hre.ethers.formatUnits(await vault.balanceOf(signerAddress), await vault.decimals()),
    );
    console.log(
      "Signer underlying balance",
      hre.ethers.formatUnits(await underlying.balanceOf(signerAddress), await underlying.decimals()),
    );

    console.log("---------------------------------------------------------------");
    console.log("Execution:");
    console.log("Approving vault to spend tokens:");
    const allowance = await underlying.allowance(signerAddress, vault.target);
    if (allowance < fixedPtAmount) {
      const tx1 = await underlying.connect(signer).approve(vault.target, fixedPtAmount);
      await tx1.wait();
      console.log("Tx", tx1.hash);
    }

    console.log("Deposit:");
    const tx3 = await vault.connect(signer).deposit(fixedPtAmount);
    await tx3.wait();
    console.log("Tx", tx3.hash);

    console.log(
      "Signer note balance",
      hre.ethers.formatUnits(await vault.balanceOf(signerAddress), await vault.decimals()),
    );
    console.log(
      "Signer underlying balance",
      hre.ethers.formatUnits(await underlying.balanceOf(signerAddress), await underlying.decimals()),
    );
  });

task("ops:vault:redeem")
  .addParam("vaultAddress", "the address of the vault contract", undefined, types.string, false)
  .addParam("amount", "the total amount of vault notes (in float) to redeem", undefined, types.string, false)
  .addParam("fromIdx", "the index of sender", 0, types.int)
  .setAction(async function (args: TaskArguments, hre) {
    const { vaultAddress, amount } = args;

    const vault = await hre.ethers.getContractAt("RolloverVault", vaultAddress);
    const underlying = await hre.ethers.getContractAt("MockERC20", await vault.underlying());
    const underlyingDecimals = await underlying.decimals();
    const fixedPtAmount = hre.ethers.parseUnits(amount, await vault.decimals());

    const signer = (await hre.ethers.getSigners())[args.fromIdx];
    const signerAddress = await signer.getAddress();
    console.log("Signer", signerAddress);
    console.log(
      "Signer note balance",
      hre.ethers.formatUnits(await vault.balanceOf(signerAddress), await vault.decimals()),
    );

    console.log("---------------------------------------------------------------");
    console.log("Preview redeem:", amount);
    const redemptions = await vault.redeem.staticCall(fixedPtAmount);
    const redemptionData = [];
    for (let i = 0; i < redemptions.length; i++) {
      const token = await hre.ethers.getContractAt("MockERC20", redemptions[i].token);
      redemptionData.push({
        asset: await token.symbol(),
        amount: hre.ethers.formatUnits(redemptions[i].amount, underlyingDecimals),
      });
    }
    console.table(redemptionData);

    console.log("---------------------------------------------------------------");
    console.log("Execution:");
    console.log("Redeem:");
    const tx = await vault.connect(signer).redeem(fixedPtAmount);
    await tx.wait();
    console.log("Tx", tx.hash);
    console.log(
      "Signer note balance",
      hre.ethers.formatUnits(await vault.balanceOf(signerAddress), await vault.decimals()),
    );
  });

task("ops:vault:mint2")
  .addParam("vaultAddress", "the address of the vault contract", undefined, types.string, false)
  .addParam(
    "underlyingAmount",
    "the total amount of underlying tokens (in float) to deposit",
    undefined,
    types.string,
    false,
  )
  .addParam("fromIdx", "the index of sender", 0, types.int)
  .setAction(async function (args: TaskArguments, hre) {
    const { vaultAddress, underlyingAmount } = args;

    const vault = await hre.ethers.getContractAt("RolloverVault", vaultAddress);
    const perp = await hre.ethers.getContractAt("PerpetualTranche", await vault.perp());
    const underlying = await hre.ethers.getContractAt("MockERC20", await vault.underlying());
    const fixedPtAmount = hre.ethers.parseUnits(underlyingAmount, await underlying.decimals());

    const signer = (await hre.ethers.getSigners())[args.fromIdx];
    const signerAddress = await signer.getAddress();
    console.log("Signer", signerAddress);

    console.log(
      "Signer perp balance",
      hre.ethers.formatUnits(await perp.balanceOf(signerAddress), await perp.decimals()),
    );
    console.log(
      "Signer note balance",
      hre.ethers.formatUnits(await vault.balanceOf(signerAddress), await vault.decimals()),
    );
    console.log(
      "Signer underlying balance",
      hre.ethers.formatUnits(await underlying.balanceOf(signerAddress), await underlying.decimals()),
    );

    console.log("---------------------------------------------------------------");
    console.log("Execution:");
    console.log("Approving vault to spend tokens:");
    const allowance = await underlying.allowance(signerAddress, vault.target);
    if (allowance < fixedPtAmount) {
      const tx1 = await underlying.connect(signer).approve(vault.target, fixedPtAmount);
      await tx1.wait();
      console.log("Tx", tx1.hash);
    }

    console.log("Mint2:");
    const tx3 = await vault.connect(signer).mint2(fixedPtAmount);
    await tx3.wait();
    console.log("Tx", tx3.hash);

    console.log(
      "Signer perp balance",
      hre.ethers.formatUnits(await perp.balanceOf(signerAddress), await perp.decimals()),
    );
    console.log(
      "Signer note balance",
      hre.ethers.formatUnits(await vault.balanceOf(signerAddress), await vault.decimals()),
    );
    console.log(
      "Signer underlying balance",
      hre.ethers.formatUnits(await underlying.balanceOf(signerAddress), await underlying.decimals()),
    );
  });

task("ops:vault:redeem2")
  .addParam("vaultAddress", "the address of the vault contract", undefined, types.string, false)
  .addParam("perpAmount", "the total amount of perp tokens (in float) to redeem", undefined, types.string, false)
  .addParam("noteAmount", "the total amount of vault notes (in float) to redeem", undefined, types.string, false)
  .addParam("fromIdx", "the index of sender", 0, types.int)
  .setAction(async function (args: TaskArguments, hre) {
    const { vaultAddress, perpAmount, noteAmount } = args;

    const vault = await hre.ethers.getContractAt("RolloverVault", vaultAddress);
    const perp = await hre.ethers.getContractAt("PerpetualTranche", await vault.perp());
    const underlying = await hre.ethers.getContractAt("MockERC20", await vault.underlying());
    const underlyingDecimals = await underlying.decimals();
    const fixedPtPerpAmount = hre.ethers.parseUnits(perpAmount, await perp.decimals());
    const fixedPtNoteAmount = hre.ethers.parseUnits(noteAmount, await vault.decimals());

    const signer = (await hre.ethers.getSigners())[args.fromIdx];
    const signerAddress = await signer.getAddress();
    console.log("Signer", signerAddress);
    console.log(
      "Signer perp balance",
      hre.ethers.formatUnits(await perp.balanceOf(signerAddress), await perp.decimals()),
    );
    console.log(
      "Signer note balance",
      hre.ethers.formatUnits(await vault.balanceOf(signerAddress), await vault.decimals()),
    );
    console.log(
      "Signer underlying balance",
      hre.ethers.formatUnits(await underlying.balanceOf(signerAddress), await underlying.decimals()),
    );

    console.log("---------------------------------------------------------------");
    console.log("Approving vault to spend perp tokens:", perpAmount);
    const allowance = await perp.allowance(signerAddress, vault.target);
    if (allowance < fixedPtPerpAmount) {
      const tx = await perp.connect(signer).approve(vault.target, fixedPtPerpAmount);
      await tx.wait();
      console.log("Tx", tx.hash);
    }

    console.log("---------------------------------------------------------------");
    console.log("Preview redeem:", perpAmount, noteAmount);
    const redemptions = await vault.redeem2.staticCall(fixedPtPerpAmount, fixedPtNoteAmount);
    console.log(
      "Redeeming:",
      hre.ethers.formatUnits(redemptions[0], await perp.decimals()),
      hre.ethers.formatUnits(redemptions[1], await vault.decimals()),
    );
    const redemptionData = [];
    for (let i = 0; i < redemptions[2].length; i++) {
      const token = await hre.ethers.getContractAt("MockERC20", redemptions[2][i].token);
      redemptionData.push({
        asset: await token.symbol(),
        amount: hre.ethers.formatUnits(redemptions[2][i].amount, underlyingDecimals),
      });
    }
    console.table(redemptionData);

    console.log("---------------------------------------------------------------");
    console.log("Execution:");
    console.log("Redeem:");
    const tx = await vault.connect(signer).redeem2(fixedPtPerpAmount, fixedPtNoteAmount);
    await tx.wait();
    console.log("Tx", tx.hash);

    console.log("---------------------------------------------------------------");
    console.log(
      "Signer perp balance",
      hre.ethers.formatUnits(await perp.balanceOf(signerAddress), await perp.decimals()),
    );
    console.log(
      "Signer note balance",
      hre.ethers.formatUnits(await vault.balanceOf(signerAddress), await vault.decimals()),
    );
    console.log(
      "Signer underlying balance",
      hre.ethers.formatUnits(await underlying.balanceOf(signerAddress), await underlying.decimals()),
    );
  });

task("ops:vault:rebalance")
  .addParam("vaultAddress", "the address of the vault contract", undefined, types.string, false)
  .addParam("fromIdx", "the index of sender", 0, types.int)
  .setAction(async function (args: TaskArguments, hre) {
    const { vaultAddress } = args;

    const vault = await hre.ethers.getContractAt("RolloverVault", vaultAddress);

    console.log("---------------------------------------------------------------");
    console.log("Execution:");
    const signer = (await hre.ethers.getSigners())[args.fromIdx];
    const signerAddress = await signer.getAddress();
    console.log("Signer", signerAddress);

    console.log("rebalance:");
    const tx = await vault.connect(signer).rebalance();
    await tx.wait();
    console.log("Tx", tx.hash);
  });

task("ops:vault:recoverAndRedeploy")
  .addParam("vaultAddress", "the address of the vault contract", undefined, types.string, false)
  .addParam("fromIdx", "the index of sender", 0, types.int)
  .setAction(async function (args: TaskArguments, hre) {
    const { vaultAddress } = args;

    const vault = await hre.ethers.getContractAt("RolloverVault", vaultAddress);

    console.log("---------------------------------------------------------------");
    console.log("Execution:");
    const signer = (await hre.ethers.getSigners())[args.fromIdx];
    const signerAddress = await signer.getAddress();
    console.log("Signer", signerAddress);

    console.log("Recover and redeploy:");
    const tx = await vault.connect(signer).recoverAndRedeploy();
    await tx.wait();
    console.log("Tx", tx.hash);
  });

task("ops:vault:deploy")
  .addParam("vaultAddress", "the address of the vault contract", undefined, types.string, false)
  .addParam("fromIdx", "the index of sender", 0, types.int)
  .setAction(async function (args: TaskArguments, hre) {
    const { vaultAddress } = args;

    const vault = await hre.ethers.getContractAt("RolloverVault", vaultAddress);

    console.log("---------------------------------------------------------------");
    console.log("Execution:");
    const signer = (await hre.ethers.getSigners())[args.fromIdx];
    const signerAddress = await signer.getAddress();
    console.log("Signer", signerAddress);

    console.log("Deploy:");
    const tx = await vault.connect(signer).deploy();
    await tx.wait();
    console.log("Tx", tx.hash);
  });

task("ops:vault:recover")
  .addParam("vaultAddress", "the address of the vault contract", undefined, types.string, false)
  .addParam("fromIdx", "the index of sender", 0, types.int)
  .setAction(async function (args: TaskArguments, hre) {
    const { vaultAddress } = args;

    const vault = await hre.ethers.getContractAt("RolloverVault", vaultAddress);

    console.log("---------------------------------------------------------------");
    console.log("Execution:");
    const signer = (await hre.ethers.getSigners())[args.fromIdx];
    const signerAddress = await signer.getAddress();
    console.log("Signer", signerAddress);

    console.log("Recover:");
    const tx = await vault.connect(signer)["recover()"]();
    await tx.wait();
    console.log("Tx", tx.hash);
  });

task("ops:vault:swapUnderlyingForPerps")
  .addParam("vaultAddress", "the address of the vault contract", undefined, types.string, false)
  .addParam(
    "underlyingAmount",
    "the total amount of underlying tokens (in float) to deposit",
    undefined,
    types.string,
    false,
  )
  .addParam("fromIdx", "the index of sender", 0, types.int)
  .setAction(async function (args: TaskArguments, hre) {
    const { vaultAddress, underlyingAmount } = args;

    const vault = await hre.ethers.getContractAt("RolloverVault", vaultAddress);
    const perp = await hre.ethers.getContractAt("PerpetualTranche", await vault.perp());
    const underlying = await hre.ethers.getContractAt("MockERC20", await vault.underlying());
    const fixedPtAmount = hre.ethers.parseUnits(underlyingAmount, await underlying.decimals());

    const signer = (await hre.ethers.getSigners())[args.fromIdx];
    const signerAddress = await signer.getAddress();
    console.log("Signer", signerAddress);

    console.log(
      "Signer perp balance",
      hre.ethers.formatUnits(await perp.balanceOf(signerAddress), await perp.decimals()),
    );
    console.log(
      "Signer underlying balance",
      hre.ethers.formatUnits(await underlying.balanceOf(signerAddress), await underlying.decimals()),
    );

    console.log("---------------------------------------------------------------");
    console.log("Execution:");
    console.log("Approving vault to spend tokens:");
    const allowance = await underlying.allowance(signerAddress, vault.target);
    if (allowance < fixedPtAmount) {
      const tx1 = await underlying.connect(signer).approve(vault.target, fixedPtAmount);
      await tx1.wait();
      console.log("Tx", tx1.hash);
    }

    console.log("Swap:");
    const tx2 = await vault.connect(signer).swapUnderlyingForPerps(fixedPtAmount);
    await tx2.wait();
    console.log("Tx", tx2.hash);

    console.log(
      "Signer perp balance",
      hre.ethers.formatUnits(await perp.balanceOf(signerAddress), await perp.decimals()),
    );
    console.log(
      "Signer underlying balance",
      hre.ethers.formatUnits(await underlying.balanceOf(signerAddress), await underlying.decimals()),
    );
  });

task("ops:vault:swapPerpsForUnderlying")
  .addParam("vaultAddress", "the address of the vault contract", undefined, types.string, false)
  .addParam("perpAmount", "the total amount of underlying tokens (in float) to deposit", undefined, types.string, false)
  .addParam("fromIdx", "the index of sender", 0, types.int)
  .setAction(async function (args: TaskArguments, hre) {
    const { vaultAddress, perpAmount } = args;

    const vault = await hre.ethers.getContractAt("RolloverVault", vaultAddress);
    const perp = await hre.ethers.getContractAt("PerpetualTranche", await vault.perp());
    const underlying = await hre.ethers.getContractAt("MockERC20", await vault.underlying());
    const fixedPtAmount = hre.ethers.parseUnits(perpAmount, await perp.decimals());

    const signer = (await hre.ethers.getSigners())[args.fromIdx];
    const signerAddress = await signer.getAddress();
    console.log("Signer", signerAddress);

    console.log(
      "Signer underlying balance",
      hre.ethers.formatUnits(await underlying.balanceOf(signerAddress), await underlying.decimals()),
    );
    console.log(
      "Signer perp balance",
      hre.ethers.formatUnits(await perp.balanceOf(signerAddress), await perp.decimals()),
    );

    console.log("---------------------------------------------------------------");
    console.log("Execution:");
    console.log("Approving vault to spend tokens:");
    const allowance = await perp.allowance(signerAddress, vault.target);
    if (allowance < fixedPtAmount) {
      const tx1 = await perp.connect(signer).approve(vault.target, fixedPtAmount);
      await tx1.wait();
      console.log("Tx", tx1.hash);
    }

    console.log("Swap:");
    const tx2 = await vault.connect(signer).swapPerpsForUnderlying(fixedPtAmount);
    await tx2.wait();
    console.log("Tx", tx2.hash);

    console.log(
      "Signer underlying balance",
      hre.ethers.formatUnits(await underlying.balanceOf(signerAddress), await underlying.decimals()),
    );
    console.log(
      "Signer perp balance",
      hre.ethers.formatUnits(await perp.balanceOf(signerAddress), await perp.decimals()),
    );
  });
