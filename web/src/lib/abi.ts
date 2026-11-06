/**
 * Minimal ABIs for the contracts this app reads and writes.
 *
 * Hand-written rather than generated, and deliberately limited to the members
 * the frontend actually uses. Each is `as const` so viem infers argument and
 * return types from it — a mistyped call fails at compile time rather than
 * reverting in a user's wallet.
 *
 * The Attestation tuple must stay byte-for-byte in step with
 * `ReviewGateway.Attestation` and with `ATTESTATION_TYPES` in the Record
 * Server: field ORDER is what the EIP-712 type hash is derived from, so
 * reordering these entries silently invalidates every signature.
 */

export const reviewGatewayAbi = [
  {
    type: 'function',
    name: 'submitFreeReview',
    stateMutability: 'nonpayable',
    inputs: [
      {
        name: 'att',
        type: 'tuple',
        components: [
          { name: 'agentId', type: 'uint256' },
          { name: 'nullifier', type: 'bytes32' },
          { name: 'reviewer', type: 'address' },
          { name: 'expiry', type: 'uint64' },
          { name: 'value', type: 'int128' },
          { name: 'valueDecimals', type: 'uint8' },
          { name: 'feedbackHash', type: 'bytes32' },
          { name: 'feedbackURI', type: 'string' },
          { name: 'reviewType', type: 'uint8' },
          { name: 'receiptId', type: 'bytes32' },
          { name: 'signature', type: 'bytes' },
        ],
      },
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'recordServerSigner',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'address' }],
  },
  {
    type: 'function',
    name: 'receiptSettler',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'address' }],
  },
  {
    type: 'function',
    name: 'nullifierRegistry',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'address' }],
  },
  {
    type: 'function',
    name: 'usedNullifier',
    stateMutability: 'view',
    inputs: [
      { name: 'agentId', type: 'uint256' },
      { name: 'nullifier', type: 'bytes32' },
    ],
    outputs: [{ type: 'bool' }],
  },
  {
    type: 'function',
    name: 'minPayment',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'uint256' }],
  },
  {
    type: 'event',
    name: 'ReviewSubmitted',
    inputs: [
      { name: 'agentId', type: 'uint256', indexed: true },
      { name: 'reviewer', type: 'address', indexed: true },
      { name: 'nullifier', type: 'bytes32', indexed: true },
      { name: 'reviewType', type: 'uint8', indexed: false },
      { name: 'receiptId', type: 'bytes32', indexed: false },
      { name: 'feedbackHash', type: 'bytes32', indexed: false },
    ],
  },
] as const;

export const identityRegistryAbi = [
  {
    type: 'function',
    name: 'ownerOf',
    stateMutability: 'view',
    inputs: [{ name: 'agentId', type: 'uint256' }],
    outputs: [{ type: 'address' }],
  },
  {
    type: 'function',
    name: 'tokenURI',
    stateMutability: 'view',
    inputs: [{ name: 'agentId', type: 'uint256' }],
    outputs: [{ type: 'string' }],
  },
  {
    type: 'function',
    name: 'getAgentWallet',
    stateMutability: 'view',
    inputs: [{ name: 'agentId', type: 'uint256' }],
    outputs: [{ type: 'address' }],
  },
  {
    type: 'function',
    name: 'isAuthorizedOrOwner',
    stateMutability: 'view',
    inputs: [
      { name: 'spender', type: 'address' },
      { name: 'agentId', type: 'uint256' },
    ],
    outputs: [{ type: 'bool' }],
  },
  {
    type: 'function',
    name: 'name',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'string' }],
  },
] as const;

export const reputationRegistryAbi = [
  {
    type: 'function',
    name: 'getClients',
    stateMutability: 'view',
    inputs: [{ name: 'agentId', type: 'uint256' }],
    outputs: [{ type: 'address[]' }],
  },
  {
    type: 'function',
    name: 'getSummary',
    stateMutability: 'view',
    inputs: [
      { name: 'agentId', type: 'uint256' },
      { name: 'clientAddresses', type: 'address[]' },
      { name: 'tag1', type: 'string' },
      { name: 'tag2', type: 'string' },
    ],
    outputs: [
      { name: 'count', type: 'uint64' },
      { name: 'summaryValue', type: 'int128' },
      { name: 'summaryValueDecimals', type: 'uint8' },
    ],
  },
  {
    type: 'function',
    name: 'readAllFeedback',
    stateMutability: 'view',
    inputs: [
      { name: 'agentId', type: 'uint256' },
      { name: 'clientAddresses', type: 'address[]' },
      { name: 'tag1', type: 'string' },
      { name: 'tag2', type: 'string' },
      { name: 'includeRevoked', type: 'bool' },
    ],
    outputs: [
      { name: 'clients', type: 'address[]' },
      { name: 'feedbackIndexes', type: 'uint64[]' },
      { name: 'values', type: 'int128[]' },
      { name: 'valueDecimals', type: 'uint8[]' },
      { name: 'tag1s', type: 'string[]' },
      { name: 'tag2s', type: 'string[]' },
      { name: 'revokedStatuses', type: 'bool[]' },
    ],
  },
] as const;
