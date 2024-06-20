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
