export type NetworkPin = { nodeUrl: string; network: string; genesisHash: string };
export type WalletIntent = { from: string; to: string; amount: string; memo: string; createdAt: number; nonce: number };
export type TransferRequest = { schema: 'agentcoin.wallet.intent.v1'; network: string; genesisHash: string; intent: WalletIntent };
export type SignedTransfer = { schema: 'agentcoin.wallet.signed.v1'; network: string; genesisHash: string; intent: WalletIntent; tx: Record<string, unknown> };
