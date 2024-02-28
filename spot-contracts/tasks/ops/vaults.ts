import { getAdminAddress, getImplementationAddress } from "@openzeppelin/upgrades-core";
import { task, types } from "hardhat/config";
import { TaskArguments } from "hardhat/types";
import { BigNumber, utils } from "ethers";

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
      await vault.callStatic.recoverAndRedeploy();
    } catch (e) {
      pokeAvailable = false;
    }
    console.log("---------------------------------------------------------------");
    console.log("RolloverVault:", vault.address);
    console.log("proxyAdmin:", proxyAdminAddress);
    console.log("implementation:", implAddress);
    console.log("owner:", await vault.owner());
    console.log("paused:", await vault.paused());
    console.log("perp:", perp.address);
    console.log("underlying:", underlying.address);
    console.log("minDeploymentAmt:", utils.formatUnits(await vault.minDeploymentAmt(), underlyingDecimals));
    console.log("totalSupply:", utils.formatUnits(vaultSupply, vaultDecimals));
    console.log("pokeAvailable:", pokeAvailable);
    console.log("---------------------------------------------------------------");
    const data = [];
    const underlyingBalance = await vault.vaultAssetBalance(underlying.address);
    data.push({
      asset: await underlying.symbol(),
      balance: utils.formatUnits(underlyingBalance, underlyingDecimals),
      price: "1",
    });
    const assetCount = (await vault.assetCount()).toNumber();
    for (let i = 1; i < assetCount; i++) {
      const tokenAddress = await vault.callStatic.assetAt(i);
      const balance = await vault.vaultAssetBalance(tokenAddress);
      const value = await vault.callStatic.getVaultAssetValue(tokenAddress);
      const price = value.mul(BigNumber.from(10 ** perpDecimals)).div(balance);

      const token = await hre.ethers.getContractAt("MockERC20", tokenAddress);
      data.push({
        asset: await token.symbol(),
        balance: utils.formatUnits(balance, underlyingDecimals),
        price: utils.formatUnits(price, perpDecimals),
      });
    }

    const perpBalance = await vault.vaultAssetBalance(perp.address);
    const perpSupply = await perp.totalSupply();
    const perpTVL = await perp.callStatic.getTVL();
    const perpPrice = perpSupply.gt("0") ? perpTVL.div(perpSupply) : 0;
    data.push({
      asset: await perp.symbol(),
      balance: utils.formatUnits(perpBalance, perpDecimals),
      price: utils.formatUnits(perpPrice, 0),
    });
    console.table(data);

    console.log("---------------------------------------------------------------");
    const feeOne = await feePolicy.ONE();
    const feeDecimals = await feePolicy.decimals();
    const vaultTVL = await vault.callStatic.getTVL();
    const seniorTR = await perp.callStatic.getDepositTrancheRatio();
    const juniorTR = BigNumber.from("1000").sub(seniorTR);
    const subscriptionRatio = vaultTVL.mul(seniorTR).mul(feeOne).div(perpTVL).div(juniorTR);
    const targetSubscriptionRatio = await feePolicy.targetSubscriptionRatio();
    const expectedVaultTVL = targetSubscriptionRatio.mul(perpTVL).mul(juniorTR).div(seniorTR).div(feeOne);

    console.log("perpTVL:", utils.formatUnits(perpTVL, underlyingDecimals));
    console.log("vaultTVL:", utils.formatUnits(vaultTVL, underlyingDecimals));
    console.log("expectedVaultTVL:", utils.formatUnits(expectedVaultTVL, underlyingDecimals));
    console.log("seniorTR:", utils.formatUnits(seniorTR, 3));
    console.log("juniorTR:", utils.formatUnits(juniorTR, 3));
    console.log("subscriptionRatio:", utils.formatUnits(subscriptionRatio, feeDecimals));
    console.log("targetSubscriptionRatio:", utils.formatUnits(targetSubscriptionRatio, feeDecimals));
    console.log("targetDeviationRatio:", utils.formatUnits(feeOne, feeDecimals));
    console.log(
      "deviationRatioBoundLower:",
      utils.formatUnits(await feePolicy.deviationRatioBoundLower(), feeDecimals),
    );
    console.log(
      "deviationRatioBoundUpper:",
      utils.formatUnits(await feePolicy.deviationRatioBoundUpper(), feeDecimals),
    );
    console.log(
      "deviationRatio:",
      utils.formatUnits(
        await feePolicy["computeDeviationRatio(uint256,uint256,uint256)"](perpTVL, vaultTVL, seniorTR),
        feeDecimals,
      ),
    );
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
    const fixedPtAmount = utils.parseUnits(underlyingAmount, await underlying.decimals());

    const signer = (await hre.ethers.getSigners())[args.fromIdx];
    const signerAddress = await signer.getAddress();
    console.log("Signer", signerAddress);

    console.log("Signer note balance", utils.formatUnits(await vault.balanceOf(signerAddress), await vault.decimals()));
    console.log(
      "Signer underlying balance",
      utils.formatUnits(await underlying.balanceOf(signerAddress), await underlying.decimals()),
    );

    console.log("---------------------------------------------------------------");
    console.log("Execution:");
    console.log("Approving router to spend tokens:");
    if ((await underlying.allowance(signerAddress, vault.address)).lt(fixedPtAmount)) {
      const tx1 = await underlying.connect(signer).approve(vault.address, fixedPtAmount);
      await tx1.wait();
      console.log("Tx", tx1.hash);
    }

    console.log("Deposit:");
    const tx3 = await vault.connect(signer).deposit(fixedPtAmount);
    await tx3.wait();
    console.log("Tx", tx3.hash);

    console.log("Signer note balance", utils.formatUnits(await vault.balanceOf(signerAddress), await vault.decimals()));
    console.log(
      "Signer underlying balance",
      utils.formatUnits(await underlying.balanceOf(signerAddress), await underlying.decimals()),
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
    const fixedPtAmount = utils.parseUnits(amount, await vault.decimals());

    const signer = (await hre.ethers.getSigners())[args.fromIdx];
    const signerAddress = await signer.getAddress();
    console.log("Signer", signerAddress);
    console.log("Signer note balance", utils.formatUnits(await vault.balanceOf(signerAddress), await vault.decimals()));

    console.log("---------------------------------------------------------------");
    console.log("Preview redeem:", amount);
    const redemptions = await vault.callStatic.redeem(fixedPtAmount);
    const redemptionData = [];
    for (let i = 0; i < redemptions.length; i++) {
      const token = await hre.ethers.getContractAt("MockERC20", redemptions[i].token);
      redemptionData.push({
        asset: await token.symbol(),
        amount: utils.formatUnits(redemptions[i].amount, underlyingDecimals),
      });
    }
    console.table(redemptionData);

    console.log("---------------------------------------------------------------");
    console.log("Execution:");
    console.log("Redeem:");
    const tx = await vault.connect(signer).redeem(fixedPtAmount);
    await tx.wait();
    console.log("Tx", tx.hash);
    console.log("Signer note balance", utils.formatUnits(await vault.balanceOf(signerAddress), await vault.decimals()));
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

task("ops:fee:setSwapFees", "Updates swap fees in fee policy")
  .addParam("address", "the fee policy contract", undefined, types.string, false)
  .addParam("feePerc", "the percentage to be set as the swap fee", undefined, types.string, false)
  .setAction(async function (args: TaskArguments, hre) {
    const { address, feePerc } = args;
    const signer = (await hre.ethers.getSigners())[0];
    const signerAddress = await signer.getAddress();
    console.log("Signer", signerAddress);
    const feePolicy = await hre.ethers.getContractAt("FeePolicy", address);
    console.log(`Updating both swap fees to ${feePerc}`);
    const feeAmtFixedPt = utils.parseUnits(feePerc, await feePolicy.decimals());

    const tx1 = await feePolicy.updateVaultUnderlyingToPerpSwapFeePerc(feeAmtFixedPt);
    console.log(tx1.hash);
    await tx1.wait();

    const tx2 = await feePolicy.updateVaultPerpToUnderlyingSwapFeePerc(feeAmtFixedPt);
    console.log(tx2.hash);
    await tx2.wait();
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
    const fixedPtAmount = utils.parseUnits(underlyingAmount, await underlying.decimals());

    const signer = (await hre.ethers.getSigners())[args.fromIdx];
    const signerAddress = await signer.getAddress();
    console.log("Signer", signerAddress);

    console.log("Signer perp balance", utils.formatUnits(await perp.balanceOf(signerAddress), await perp.decimals()));
    console.log(
      "Signer underlying balance",
      utils.formatUnits(await underlying.balanceOf(signerAddress), await underlying.decimals()),
    );

    console.log("---------------------------------------------------------------");
    console.log("Execution:");
    console.log("Approving router to spend tokens:");
    if ((await underlying.allowance(signerAddress, vault.address)).lt(fixedPtAmount)) {
      const tx1 = await underlying.connect(signer).approve(vault.address, fixedPtAmount);
      await tx1.wait();
      console.log("Tx", tx1.hash);
    }

    console.log("Swap:");
    const tx2 = await vault.connect(signer).swapUnderlyingForPerps(fixedPtAmount);
    await tx2.wait();
    console.log("Tx", tx2.hash);

    console.log("Signer perp balance", utils.formatUnits(await perp.balanceOf(signerAddress), await perp.decimals()));
    console.log(
      "Signer underlying balance",
      utils.formatUnits(await underlying.balanceOf(signerAddress), await underlying.decimals()),
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
    const fixedPtAmount = utils.parseUnits(perpAmount, await perp.decimals());

    const signer = (await hre.ethers.getSigners())[args.fromIdx];
    const signerAddress = await signer.getAddress();
    console.log("Signer", signerAddress);

    console.log(
      "Signer underlying balance",
      utils.formatUnits(await underlying.balanceOf(signerAddress), await underlying.decimals()),
    );
    console.log("Signer perp balance", utils.formatUnits(await perp.balanceOf(signerAddress), await perp.decimals()));

    console.log("---------------------------------------------------------------");
    console.log("Execution:");
    console.log("Approving router to spend tokens:");
    if ((await perp.allowance(signerAddress, vault.address)).lt(fixedPtAmount)) {
      const tx1 = await perp.connect(signer).approve(vault.address, fixedPtAmount);
      await tx1.wait();
      console.log("Tx", tx1.hash);
    }

    console.log("Swap:");
    const tx2 = await vault.connect(signer).swapPerpsForUnderlying(fixedPtAmount);
    await tx2.wait();
    console.log("Tx", tx2.hash);

    console.log(
      "Signer underlying balance",
      utils.formatUnits(await underlying.balanceOf(signerAddress), await underlying.decimals()),
    );
    console.log("Signer perp balance", utils.formatUnits(await perp.balanceOf(signerAddress), await perp.decimals()));
  });
