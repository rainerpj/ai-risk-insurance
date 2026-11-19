// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;
/// @notice Stateless calculation only; owns no money, state or permissions.
contract SettlementMath {
    struct Expense { uint256 gross; uint256 duplicate; uint256 compensation; uint256 recovery; }
    struct Limits { uint256 P; uint256 R; uint256 otherOccupied; uint256 incidentLimit; uint256 annualLimit; uint256 oldDue; uint256 claimed; uint256 reviewAmount; }
    error AmountMismatch();
    function calculate(Expense[2] calldata amounts, Limits calldata l) external pure returns (uint256 approved, uint256 due, uint256 refund) {
        uint256 loss;
        for (uint256 j; j < 2; j++) {
            uint256 deductions = amounts[j].duplicate + amounts[j].compensation + amounts[j].recovery;
            if (deductions > amounts[j].gross) revert AmountMismatch(); loss += amounts[j].gross - deductions;
        }
        uint256 extra = l.incidentLimit - l.P;
        uint256 annualExtra = l.annualLimit - l.otherOccupied - l.P;
        if (extra > annualExtra) extra = annualExtra;
        uint256 retained = l.P - l.R;
        uint256 cap = retained + extra;
        approved = loss < cap ? loss : cap;
        if (approved != l.claimed || l.reviewAmount < loss || l.reviewAmount < l.P + l.oldDue || l.reviewAmount < approved) revert AmountMismatch();
        due = approved > retained ? approved - retained : 0;
        refund = retained > approved ? retained - approved : 0;
    }
}
