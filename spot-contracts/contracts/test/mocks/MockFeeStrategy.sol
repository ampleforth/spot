// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.19;

contract MockFeeStrategy {
    int256 private _mintFee;
    int256 private _burnFee;
    int256 private _rolloverFee;
    uint256 private _protocolFee;
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

    function setProtocolFee(uint256 f) external {
        _protocolFee = f;
    }

    function feeToken() external view returns (address) {
        return _feeToken;
    }

    function computeMintFees(
        uint256 /* f */
    ) external view returns (int256, uint256) {
        return (_mintFee, _protocolFee);
    }

    function computeBurnFees(
        uint256 /* f */
    ) external view returns (int256, uint256) {
        return (_burnFee, _protocolFee);
    }

    function computeRolloverFees(
        uint256 /* f */
    ) external view returns (int256, uint256) {
        return (_rolloverFee, _protocolFee);
    }
}
