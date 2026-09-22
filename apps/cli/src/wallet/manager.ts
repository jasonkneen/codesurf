import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { createPublicClient, formatEther, formatUnits, http } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { base, baseSepolia } from "viem/chains";
import { getCodesurfConfigDir } from "../utils/config-dir";
import type { PaymentChain } from "../utils/settings";
import type { WalletBalance, WalletData } from "./types";

const LEGACY_WALLET_PATH = path.join(os.homedir(), ".grok", "wallet.json");

function getWalletDir(): string {
  return getCodesurfConfigDir();
}

function getWalletPath(): string {
  return path.join(getWalletDir(), "wallet.json");
}

/** One-time best-effort copy of ~/.grok/wallet.json into the resolved codesurf
 *  config dir. Copy never moves — legacy stays as a safety net. Skipped when
 *  CODESURF_CONFIG_DIR is set (test/sandbox override). */
function migrateLegacyWalletOnce(): void {
  if (process.env.CODESURF_CONFIG_DIR?.trim()) return;

  const walletPath = getWalletPath();
  if (fs.existsSync(walletPath)) return;
  if (walletPath === LEGACY_WALLET_PATH) return;
  if (!fs.existsSync(LEGACY_WALLET_PATH)) return;

  try {
    const dir = getWalletDir();
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.copyFileSync(LEGACY_WALLET_PATH, walletPath);
    fs.chmodSync(walletPath, 0o600);
    process.stderr.write(
      `[codesurf] migrated wallet from ${LEGACY_WALLET_PATH} to ${walletPath} (legacy file preserved).\n`,
    );
  } catch (err) {
    process.stderr.write(`[codesurf] wallet migration from ${LEGACY_WALLET_PATH} failed: ${(err as Error).message}.\n`);
  }
}

const USDC_BY_CHAIN: Record<PaymentChain, `0x${string}`> = {
  base: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  "base-sepolia": "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
};

const ERC20_BALANCE_ABI = [
  {
    inputs: [{ name: "account", type: "address" }],
    name: "balanceOf",
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
] as const;

export interface StoredWallet {
  privateKey: `0x${string}`;
  address: string;
  chain: PaymentChain;
  createdAt: string;
}

export class WalletManager {
  static exists(): boolean {
    migrateLegacyWalletOnce();
    if (fs.existsSync(getWalletPath())) return true;
    // Isolated config dirs (tests / overrides) never peek at the real ~/.grok wallet.
    if (process.env.CODESURF_CONFIG_DIR?.trim()) {
      return false;
    }
    return fs.existsSync(LEGACY_WALLET_PATH);
  }

  init(chain: PaymentChain = "base-sepolia"): WalletData {
    migrateLegacyWalletOnce();
    if (WalletManager.exists()) {
      const current = this.getStoredWallet();
      return { address: current.address, chain: current.chain, createdAt: current.createdAt };
    }

    const privateKey = generatePrivateKey();
    const account = privateKeyToAccount(privateKey);
    const createdAt = new Date().toISOString();
    const stored: StoredWallet = { privateKey, address: account.address, chain, createdAt };

    const dir = getWalletDir();
    const walletPath = getWalletPath();
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(walletPath, JSON.stringify(stored, null, 2), { mode: 0o600 });

    return { address: stored.address, chain: stored.chain, createdAt: stored.createdAt };
  }

  getWalletData(): WalletData {
    const stored = this.getStoredWallet();
    return { address: stored.address, chain: stored.chain, createdAt: stored.createdAt };
  }

  getStoredWallet(): StoredWallet {
    migrateLegacyWalletOnce();
    const walletPath = getWalletPath();
    let readPath: string | null = fs.existsSync(walletPath) ? walletPath : null;
    if (
      !readPath &&
      !process.env.CODESURF_CONFIG_DIR?.trim() &&
      !process.env.CODESURF_CONFIG_DIR?.trim() &&
      fs.existsSync(LEGACY_WALLET_PATH)
    ) {
      readPath = LEGACY_WALLET_PATH;
    }
    if (!readPath) {
      throw new Error("No wallet found. Run `codesurf wallet init` first.");
    }
    const parsed = JSON.parse(fs.readFileSync(readPath, "utf-8")) as Partial<StoredWallet>;
    if (!parsed.privateKey || !parsed.address || !parsed.chain || !parsed.createdAt) {
      throw new Error("Wallet file is incomplete.");
    }
    if (parsed.chain !== "base" && parsed.chain !== "base-sepolia") {
      throw new Error(`Unsupported wallet chain: ${parsed.chain}`);
    }
    return parsed as StoredWallet;
  }

  async getBalance(): Promise<WalletBalance> {
    const stored = this.getStoredWallet();
    const viemChain = stored.chain === "base" ? base : baseSepolia;
    const publicClient = createPublicClient({ chain: viemChain, transport: http() });

    const nativeBalance = await publicClient.getBalance({ address: stored.address as `0x${string}` });
    const usdcBalance = await publicClient.readContract({
      address: USDC_BY_CHAIN[stored.chain],
      abi: ERC20_BALANCE_ABI,
      functionName: "balanceOf",
      args: [stored.address as `0x${string}`],
    });

    return {
      address: stored.address,
      chain: stored.chain,
      nativeSymbol: "ETH",
      nativeBalance: formatEther(nativeBalance),
      usdcBalance: formatUnits(usdcBalance, 6),
    };
  }
}
