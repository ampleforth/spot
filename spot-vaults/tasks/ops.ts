import { task, types } from "hardhat/config";
import { TaskArguments } from "hardhat/types";
import { ethers } from "ethers";

task("mock:usdPrice", "Mocks usd price")
  .addPositionalParam(
    "oracleAddress",
    "the address of the usd oracle",
    undefined,
    types.string,
    false,
  )
  .setAction(async function (args: TaskArguments, hre) {
    const deployer = (await hre.ethers.getSigners())[0];
    console.log("Signer", await deployer.getAddress());

    const { oracleAddress } = args;
    const oracle = await hre.ethers.getContractAt("MockCLOracle", oracleAddress);
    const tx = await oracle.mockLastRoundData("100000000", parseInt(Date.now() / 1000));
    await tx.wait();
    console.log("tx", tx.hash);
  });

task("ops:deposit", "Deposits perp and usd tokens to mint bb lp tokens")
  .addParam(
    "address",
    "the address of the bill broker contract",
    undefined,
    types.string,
    false,
  )
  .addParam(
    "usdAmount",
    "the total amount of usd tokens (in float) to deposit",
    undefined,
    types.string,
    false,
  )
  .addParam(
    "perpAmount",
    "the total amount of usd tokens (in float) to deposit",
    undefined,
    types.string,
    false,
  )
  .setAction(async function (args: TaskArguments, hre) {
    const signer = (await hre.ethers.getSigners())[0];
    const signerAddress = await signer.getAddress();
    console.log("Signer", signerAddress);

    const { address, usdAmount, perpAmount } = args;
    const billBroker = await hre.ethers.getContractAt("BillBroker", address);
    const usd = await hre.ethers.getContractAt("ERC20", await billBroker.usd());
    const perp = await hre.ethers.getContractAt("ERC20", await billBroker.perp());
    const usdFixedPtAmount = ethers.parseUnits(usdAmount, await usd.decimals());
    const perpFixedPtAmount = ethers.parseUnits(perpAmount, await perp.decimals());

    console.log(
      "Signer perp balance",
      ethers.formatUnits(await perp.balanceOf(signerAddress), await perp.decimals()),
    );
    console.log(
      "Signer usd balance",
      ethers.formatUnits(await usd.balanceOf(signerAddress), await usd.decimals()),
    );

    console.log("---------------------------------------------------------------");
    console.log("Execution:");
    console.log("Approving router to spend tokens:");
    if ((await usd.allowance(signerAddress, billBroker.target)) < usdFixedPtAmount) {
      const tx1 = await usd.connect(signer).approve(billBroker.target, usdFixedPtAmount);
      await tx1.wait();
      console.log("Tx", tx1.hash);
    }
    if ((await perp.allowance(signerAddress, billBroker.target)) < perpFixedPtAmount) {
      const tx2 = await perp
        .connect(signer)
        .approve(billBroker.target, perpFixedPtAmount);
      await tx2.wait();
      console.log("Tx", tx2.hash);
    }

    console.log("Deposit:");
    const expectedDepositAmts = await billBroker.computeMintAmt.staticCall(
      usdFixedPtAmount,
      perpFixedPtAmount,
    );
    const tx3 = await billBroker
      .connect(signer)
      .deposit(
        usdFixedPtAmount,
        perpFixedPtAmount,
        expectedDepositAmts[1],
        expectedDepositAmts[2],
      );
    await tx3.wait();
    console.log("Tx", tx3.hash);

    console.log(
      "Signer lp balance",
      ethers.formatUnits(
        await billBroker.balanceOf(signerAddress),
        await billBroker.decimals(),
      ),
    );
    console.log(
      "Signer perp balance",
      ethers.formatUnits(await perp.balanceOf(signerAddress), await perp.decimals()),
    );
    console.log(
      "Signer usd balance",
      ethers.formatUnits(await usd.balanceOf(signerAddress), await usd.decimals()),
    );
  });

task("ops:depositPerp", "Deposits perp tokens to mint bb lp tokens")
  .addParam(
    "address",
    "the address of the bill broker contract",
    undefined,
    types.string,
    false,
  )
  .addParam(
    "perpAmount",
    "the total amount of usd tokens (in float) to deposit",
    undefined,
    types.string,
    false,
  )
  .setAction(async function (args: TaskArguments, hre) {
    const signer = (await hre.ethers.getSigners())[0];
    const signerAddress = await signer.getAddress();
    console.log("Signer", signerAddress);

    const { address, perpAmount } = args;
    const billBroker = await hre.ethers.getContractAt("BillBroker", address);
    const perp = await hre.ethers.getContractAt("ERC20", await billBroker.perp());
    const perpFixedPtAmount = ethers.parseUnits(perpAmount, await perp.decimals());

    console.log(
      "Signer perp balance",
      ethers.formatUnits(await perp.balanceOf(signerAddress), await perp.decimals()),
    );

    console.log("---------------------------------------------------------------");
    console.log("Execution:");
    console.log("Approving router to spend tokens:");
    if ((await perp.allowance(signerAddress, billBroker.target)) < perpFixedPtAmount) {
      const tx = await perp.connect(signer).approve(billBroker.target, perpFixedPtAmount);
      await tx.wait();
      console.log("Tx", tx.hash);
    }

    console.log("Deposit:");
    const tx = await billBroker.connect(signer).depositPerp(perpFixedPtAmount, 0);
    await tx.wait();
    console.log("Tx", tx.hash);

    console.log(
      "Signer lp balance",
      ethers.formatUnits(
        await billBroker.balanceOf(signerAddress),
        await billBroker.decimals(),
      ),
    );
    console.log(
      "Signer perp balance",
      ethers.formatUnits(await perp.balanceOf(signerAddress), await perp.decimals()),
    );
  });

task("ops:depositUSD", "Deposits usd tokens to mint bb lp tokens")
  .addParam(
    "address",
    "the address of the bill broker contract",
    undefined,
    types.string,
    false,
  )
  .addParam(
    "usdAmount",
    "the total amount of usd tokens (in float) to deposit",
    undefined,
    types.string,
    false,
  )
  .setAction(async function (args: TaskArguments, hre) {
    const signer = (await hre.ethers.getSigners())[0];
    const signerAddress = await signer.getAddress();
    console.log("Signer", signerAddress);

    const { address, usdAmount } = args;
    const billBroker = await hre.ethers.getContractAt("BillBroker", address);
    const usd = await hre.ethers.getContractAt("ERC20", await billBroker.usd());
    const usdFixedPtAmount = ethers.parseUnits(usdAmount, await usd.decimals());

    console.log(
      "Signer usd balance",
      ethers.formatUnits(await usd.balanceOf(signerAddress), await usd.decimals()),
    );

    console.log("---------------------------------------------------------------");
    console.log("Execution:");
    console.log("Approving router to spend tokens:");
    if ((await usd.allowance(signerAddress, billBroker.target)) < usdFixedPtAmount) {
      const tx = await usd.connect(signer).approve(billBroker.target, usdFixedPtAmount);
      await tx.wait();
      console.log("Tx", tx.hash);
    }

    console.log("Deposit:");
    const tx = await billBroker
      .connect(signer)
      .depositUSD(usdFixedPtAmount, hre.ethers.MaxUint256);
    await tx.wait();
    console.log("Tx", tx.hash);

    console.log(
      "Signer lp balance",
      ethers.formatUnits(
        await billBroker.balanceOf(signerAddress),
        await billBroker.decimals(),
      ),
    );
    console.log(
      "Signer usd balance",
      ethers.formatUnits(await usd.balanceOf(signerAddress), await usd.decimals()),
    );
  });

task("ops:redeem")
  .addParam(
    "address",
    "the address of the billBroker contract",
    undefined,
    types.string,
    false,
  )
  .addParam(
    "amount",
    "the total amount of bill broker LP tokens (in float) to redeem",
    undefined,
    types.string,
    false,
  )
  .setAction(async function (args: TaskArguments, hre) {
    const signer = (await hre.ethers.getSigners())[0];
    const signerAddress = await signer.getAddress();
    console.log("Signer", signerAddress);

    const { address, amount } = args;

    const billBroker = await hre.ethers.getContractAt("BillBroker", address);
    const usd = await hre.ethers.getContractAt("ERC20", await billBroker.usd());
    const usdDecimals = await usd.decimals();
    const perp = await hre.ethers.getContractAt("ERC20", await billBroker.perp());
    const perpDecimals = await perp.decimals();

    const fixedPtAmount = ethers.parseUnits(amount, await billBroker.decimals());
    console.log(
      "Signer LP balance",
      ethers.formatUnits(
        await billBroker.balanceOf(signerAddress),
        await billBroker.decimals(),
      ),
    );

    console.log("---------------------------------------------------------------");
    console.log("Preview redeem:", amount);
    const redemptions = await billBroker.redeem.staticCall(fixedPtAmount);

    const redemptionData = [];
    redemptionData.push({
      asset: "usd",
      amount: ethers.formatUnits(redemptions[0], usdDecimals),
    });
    redemptionData.push({
      asset: "perp",
      amount: ethers.formatUnits(redemptions[1], perpDecimals),
    });
    console.table(redemptionData);

    console.log("---------------------------------------------------------------");
    console.log("Execution:");
    console.log("Redeem:");
    const tx = await billBroker.connect(signer).redeem(fixedPtAmount);
    await tx.wait();
    console.log("Tx", tx.hash);
    console.log(
      "Signer LP balance",
      ethers.formatUnits(
        await billBroker.balanceOf(signerAddress),
        await billBroker.decimals(),
      ),
    );
  });

task("ops:swapUSDForPerps")
  .addParam(
    "address",
    "the address of the bill broker contract",
    undefined,
    types.string,
    false,
  )
  .addParam(
    "usdAmount",
    "the total amount of usd tokens (in float) to deposit",
    undefined,
    types.string,
    false,
  )
  .setAction(async function (args: TaskArguments, hre) {
    const signer = (await hre.ethers.getSigners())[0];
    const signerAddress = await signer.getAddress();
    console.log("Signer", signerAddress);

    const { address, usdAmount } = args;

    const billBroker = await hre.ethers.getContractAt("BillBroker", address);
    const usd = await hre.ethers.getContractAt("ERC20", await billBroker.usd());
    const perp = await hre.ethers.getContractAt("ERC20", await billBroker.perp());
    const fixedPtAmount = ethers.parseUnits(usdAmount, await usd.decimals());

    console.log(
      "Signer perp balance",
      ethers.formatUnits(await perp.balanceOf(signerAddress), await perp.decimals()),
    );
    console.log(
      "Signer usd balance",
      ethers.formatUnits(await usd.balanceOf(signerAddress), await usd.decimals()),
    );

    console.log("---------------------------------------------------------------");
    console.log("Execution:");
    console.log("Approving billBroker to spend tokens:");
    if ((await usd.allowance(signerAddress, billBroker.target)) < fixedPtAmount) {
      const tx1 = await usd.connect(signer).approve(billBroker.target, fixedPtAmount);
      await tx1.wait();
      console.log("Tx", tx1.hash);
    }

    console.log("Swap:");
    const tx2 = await billBroker.connect(signer).swapUSDForPerps(fixedPtAmount, "0");
    await tx2.wait();
    console.log("Tx", tx2.hash);

    console.log(
      "Signer perp balance",
      ethers.formatUnits(await perp.balanceOf(signerAddress), await perp.decimals()),
    );
    console.log(
      "Signer usd balance",
      ethers.formatUnits(await usd.balanceOf(signerAddress), await usd.decimals()),
    );
  });

task("ops:swapPerpsForUSD")
  .addParam(
    "address",
    "the address of the billBroker contract",
    undefined,
    types.string,
    false,
  )
  .addParam(
    "perpAmount",
    "the total amount of perp tokens (in float) to deposit",
    undefined,
    types.string,
    false,
  )
  .setAction(async function (args: TaskArguments, hre) {
    const signer = (await hre.ethers.getSigners())[0];
    const signerAddress = await signer.getAddress();
    console.log("Signer", signerAddress);

    const { address, perpAmount } = args;
    const billBroker = await hre.ethers.getContractAt("BillBroker", address);
    const perp = await hre.ethers.getContractAt("ERC20", await billBroker.perp());
    const usd = await hre.ethers.getContractAt("ERC20", await billBroker.usd());
    const fixedPtAmount = ethers.parseUnits(perpAmount, await perp.decimals());

    console.log(
      "Signer usd balance",
      ethers.formatUnits(await usd.balanceOf(signerAddress), await usd.decimals()),
    );
    console.log(
      "Signer perp balance",
      ethers.formatUnits(await perp.balanceOf(signerAddress), await perp.decimals()),
    );

    console.log("---------------------------------------------------------------");
    console.log("Execution:");
    console.log("Approving router to spend tokens:");
    if ((await perp.allowance(signerAddress, billBroker.target)) < fixedPtAmount) {
      const tx1 = await perp.connect(signer).approve(billBroker.target, fixedPtAmount);
      await tx1.wait();
      console.log("Tx", tx1.hash);
    }

    console.log("Swap:");
    const tx2 = await billBroker.connect(signer).swapPerpsForUSD(fixedPtAmount, "0");
    await tx2.wait();
    console.log("Tx", tx2.hash);

    console.log(
      "Signer usd balance",
      ethers.formatUnits(await usd.balanceOf(signerAddress), await usd.decimals()),
    );
    console.log(
      "Signer perp balance",
      ethers.formatUnits(await perp.balanceOf(signerAddress), await perp.decimals()),
    );
  });

task("ops:drVaultRebalance", "Calls rebalance on DRBalancerVault")
  .addParam(
    "address",
    "the address of the DRBalancerVault contract",
    undefined,
    types.string,
    false,
  )
  .setAction(async function (args: TaskArguments, hre) {
    const signer = (await hre.ethers.getSigners())[0];
    const signerAddress = await signer.getAddress();
    console.log("Signer", signerAddress);

    const { address } = args;
    const vault = await hre.ethers.getContractAt("DRBalancerVault", address);
    const underlying = await hre.ethers.getContractAt("ERC20", await vault.underlying());
    const perp = await hre.ethers.getContractAt("ERC20", await vault.perp());
    const stampl = await hre.ethers.getContractAt("IRolloverVault", await vault.stampl());
    const underlyingDecimals = await underlying.decimals();
    const perpDecimals = await perp.decimals();
    const drDecimals = await vault.DR_DECIMALS();

    console.log("---------------------------------------------------------------");
    console.log("State before rebalance:");
    const drBefore = await stampl.deviationRatio.staticCall();
    console.log("System DR:", ethers.formatUnits(drBefore, drDecimals));
    console.log(
      "Vault underlying balance:",
      ethers.formatUnits(await vault.underlyingBalance(), underlyingDecimals),
    );
    console.log(
      "Vault perp balance:",
      ethers.formatUnits(await vault.perpBalance(), perpDecimals),
    );

    const lastRebalance = await vault.lastRebalanceTimestampSec();
    const rebalanceFreq = await vault.rebalanceFreqSec();
    const nextRebalanceTime = Number(lastRebalance) + Number(rebalanceFreq);
    const now = Math.floor(Date.now() / 1000);
    console.log(
      "Last rebalance:",
      lastRebalance > 0 ? new Date(Number(lastRebalance) * 1000).toISOString() : "never",
    );
    console.log("Rebalance frequency (sec):", rebalanceFreq.toString());
    console.log(
      "Can rebalance:",
      now >= nextRebalanceTime ? "yes" : `no (wait ${nextRebalanceTime - now}s)`,
    );

    console.log("---------------------------------------------------------------");
    console.log("Rebalance preview:");
    try {
      const [rebalanceAmt, isUnderlyingIntoPerp] =
        await vault.computeRebalanceAmount.staticCall();
      console.log(
        "Rebalance amount:",
        ethers.formatUnits(rebalanceAmt, underlyingDecimals),
      );
      console.log(
        "Direction:",
        isUnderlyingIntoPerp
          ? "underlying -> perp (mint)"
          : "perp -> underlying (redeem)",
      );

      if (rebalanceAmt === 0n) {
        console.log(
          "No rebalance needed (within equilibrium range or insufficient liquidity)",
        );
        return;
      }
    } catch (e) {
      console.log("Unable to preview rebalance:", e.message);
    }

    console.log("---------------------------------------------------------------");
    console.log("Execution:");
    console.log("Calling rebalance...");
    const tx = await vault.connect(signer).rebalance();
    await tx.wait();
    console.log("Tx", tx.hash);

    console.log("---------------------------------------------------------------");
    console.log("State after rebalance:");
    const drAfter = await stampl.deviationRatio.staticCall();
    console.log("System DR:", ethers.formatUnits(drAfter, drDecimals));
    console.log(
      "Vault underlying balance:",
      ethers.formatUnits(await vault.underlyingBalance(), underlyingDecimals),
    );
    console.log(
      "Vault perp balance:",
      ethers.formatUnits(await vault.perpBalance(), perpDecimals),
    );
  });

task("ops:drVaultDeposit", "Deposits underlying and perp tokens to DRBalancerVault")
  .addParam(
    "address",
    "the address of the DRBalancerVault contract",
    undefined,
    types.string,
    false,
  )
  .addParam(
    "underlyingAmount",
    "the amount of underlying tokens (in float) to deposit",
    undefined,
    types.string,
    false,
  )
  .addParam(
    "perpAmount",
    "the amount of perp tokens (in float) to deposit",
    undefined,
    types.string,
    false,
  )
  .setAction(async function (args: TaskArguments, hre) {
    const signer = (await hre.ethers.getSigners())[0];
    const signerAddress = await signer.getAddress();
    console.log("Signer", signerAddress);

    const { address, underlyingAmount, perpAmount } = args;
    const vault = await hre.ethers.getContractAt("DRBalancerVault", address);
    const underlying = await hre.ethers.getContractAt("ERC20", await vault.underlying());
    const perp = await hre.ethers.getContractAt("ERC20", await vault.perp());
    const underlyingDecimals = await underlying.decimals();
    const perpDecimals = await perp.decimals();
    const underlyingFixedPtAmount = ethers.parseUnits(
      underlyingAmount,
      underlyingDecimals,
    );
    const perpFixedPtAmount = ethers.parseUnits(perpAmount, perpDecimals);

    console.log(
      "Signer underlying balance",
      ethers.formatUnits(await underlying.balanceOf(signerAddress), underlyingDecimals),
    );
    console.log(
      "Signer perp balance",
      ethers.formatUnits(await perp.balanceOf(signerAddress), perpDecimals),
    );

    console.log("---------------------------------------------------------------");
    console.log("Preview deposit:");
    const [expectedNotes, expectedUnderlying, expectedPerp] =
      await vault.computeMintAmt.staticCall(underlyingFixedPtAmount, perpFixedPtAmount);
    console.log(
      "Expected notes:",
      ethers.formatUnits(expectedNotes, await vault.decimals()),
    );
    console.log(
      "Expected underlying in:",
      ethers.formatUnits(expectedUnderlying, underlyingDecimals),
    );
    console.log("Expected perp in:", ethers.formatUnits(expectedPerp, perpDecimals));

    console.log("---------------------------------------------------------------");
    console.log("Execution:");
    console.log("Approving vault to spend tokens:");
    if (
      (await underlying.allowance(signerAddress, vault.target)) < underlyingFixedPtAmount
    ) {
      const tx1 = await underlying
        .connect(signer)
        .approve(vault.target, underlyingFixedPtAmount);
      await tx1.wait();
      console.log("Tx", tx1.hash);
    }
    if ((await perp.allowance(signerAddress, vault.target)) < perpFixedPtAmount) {
      const tx2 = await perp.connect(signer).approve(vault.target, perpFixedPtAmount);
      await tx2.wait();
      console.log("Tx", tx2.hash);
    }

    console.log("Deposit:");
    const tx3 = await vault
      .connect(signer)
      .deposit(underlyingFixedPtAmount, perpFixedPtAmount, 0);
    await tx3.wait();
    console.log("Tx", tx3.hash);

    console.log("---------------------------------------------------------------");
    console.log(
      "Signer vault notes balance",
      ethers.formatUnits(await vault.balanceOf(signerAddress), await vault.decimals()),
    );
    console.log(
      "Signer underlying balance",
      ethers.formatUnits(await underlying.balanceOf(signerAddress), underlyingDecimals),
    );
    console.log(
      "Signer perp balance",
      ethers.formatUnits(await perp.balanceOf(signerAddress), perpDecimals),
    );

    console.log("---------------------------------------------------------------");
    console.log("Rebalance status:");
    const lastRebalance = await vault.lastRebalanceTimestampSec();
    const rebalanceFreq = await vault.rebalanceFreqSec();
    const nextRebalanceTime = Number(lastRebalance) + Number(rebalanceFreq);
    const now = Math.floor(Date.now() / 1000);
    const canRebalance = now >= nextRebalanceTime;
    console.log(
      "Can rebalance:",
      canRebalance ? "yes" : `no (wait ${nextRebalanceTime - now}s)`,
    );

    try {
      const [rebalanceAmt, isUnderlyingIntoPerp] =
        await vault.computeRebalanceAmount.staticCall();
      console.log(
        "Rebalance amount:",
        ethers.formatUnits(rebalanceAmt, underlyingDecimals),
      );
      console.log(
        "Direction:",
        isUnderlyingIntoPerp
          ? "underlying -> perp (mint)"
          : "perp -> underlying (redeem)",
      );
      console.log("Rebalance pokable:", canRebalance && rebalanceAmt > 0n ? "yes" : "no");
    } catch (e) {
      console.log("Unable to compute rebalance:", e.message);
    }
  });
