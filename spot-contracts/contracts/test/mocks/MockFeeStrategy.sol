// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.0;

contract MockFeeStrategy {
    int256 private _mintFee;
    int256 private _burnFee;
    int256 private _rolloverFee;
    address private _feeToken;

    function setFeeToken(address t) external {
        _feeToken = t;
    }

    function setMintFee(int256 f) external {
        _mintFee = f;
    }

    function setBurnFee(int256 f) external {
        _burnFee = f;
    }

    function setRolloverFee(int256 f) external {
        _rolloverFee = f;
    }

    function feeToken() external view returns (address) {
        return _feeToken;
    }

    // solhint-disable-next-line no-unused-vars
    function computeMintFee(uint256 a) external view returns (int256) {
        return _mintFee;
    }

    // solhint-disable-next-line no-unused-vars
    function computeBurnFee(uint256 a) external view returns (int256) {
        return _burnFee;
    }

    // solhint-disable-next-line no-unused-vars
    function computeRolloverFee(uint256 a) external view returns (int256) {
        return _rolloverFee;
    }
}
