// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title IReviewGateway
/// @notice The handshake ReceiptSettler performs before naming a gateway active.
/// @dev Deliberately minimal: the two facts the settler validates before making
///      a candidate active.
///
///      `receiptSettler()` must equal the settler itself, and
///      `nullifierRegistry()` must be non-zero and — when replacing an existing
///      gateway — equal the incumbent's. Reading both back from the candidate is
///      what makes a single-transaction replacement safe: a typo, an EOA, an
///      unrelated contract, a gateway wired to another deployment, or one
///      carrying a different nullifier ledger all fail before becoming the
///      active pointer rather than after.
interface IReviewGateway {
    /// @notice The ReceiptSettler this gateway was constructed against.
    function receiptSettler() external view returns (address settler);

    /// @notice The shared nullifier ledger this gateway writes to.
    /// @dev Read during replacement so a successor cannot arrive with a
    ///      different ledger. A fresh registry bound to the same settler would
    ///      pass every other check while silently emptying the
    ///      one-human-one-review history.
    function nullifierRegistry() external view returns (address registry);
}
