import { task, types } from "hardhat/config";
import { TaskArguments } from "hardhat/types";

task("ops:increaseTimeBy")
  .addPositionalParam("timeInSec", "the number of seconds to advance the clock", undefined, types.int, false)
  .setAction(async function (args: TaskArguments, hre) {
    await hre.network.provider.send("evm_increaseTime", [args.timeInSec]);
    await hre.network.provider.send("evm_mine");
    const res = await hre.network.provider.send("eth_getBlockByNumber", ["latest", false]);
    const timestamp = parseInt(res.timestamp, 16);
    console.log(timestamp);
  });

task("ops:increaseTimeTo")
  .addPositionalParam("timestampSec", "the new time", undefined, types.int, false)
  .setAction(async function (args: TaskArguments, hre) {
    await hre.network.provider.send("evm_setNextBlockTimestamp", [args.timestampSec]);
    await hre.network.provider.send("evm_mine");
    const res = await hre.network.provider.send("eth_getBlockByNumber", ["latest", false]);
    const timestamp = parseInt(res.timestamp, 16);
    console.log(timestamp);
  });
