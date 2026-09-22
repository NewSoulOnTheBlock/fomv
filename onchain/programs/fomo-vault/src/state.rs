use anchor_lang::prelude::*;

use crate::errors::VaultError;

/// Assets a single vault may hold. Bounded because every open withdrawal claim
/// carries a bitmap of which assets it has already drawn.
pub const MAX_ASSETS: u16 = 256;
pub const CLAIM_BITMAP_BYTES: usize = (MAX_ASSETS as usize) / 8;

pub const VAULT_SEED: &[u8] = b"vault";
pub const SHARE_MINT_SEED: &[u8] = b"shares";
pub const ASSET_SEED: &[u8] = b"asset";
pub const DEPOSIT_SEED: &[u8] = b"deposit";
pub const CLAIM_SEED: &[u8] = b"claim";
pub const PENDING_SEED: &[u8] = b"pending";

#[account]
#[derive(InitSpace)]
pub struct Vault {
    pub bump: u8,
    /// Display name, zero-padded.
    pub name: [u8; 32],

    /// FOMV platform this vault was listed under. Binds the vault to the
    /// treasury that its withdrawal fee is paid to.
    pub platform: Pubkey,

    /// The fomo trader being mirrored. Identity only: this key never signs.
    pub leader: Pubkey,
    /// Crank authorised to post NAV and route trades.
    pub manager: Pubkey,
    pub quote_mint: Pubkey,
    pub share_mint: Pubkey,

    /// Last posted total vault value, in quote units, excluding the pending
    /// deposit bucket. Only ever used to price *entries*; exits are in-kind and
    /// never consult it.
    pub nav_quote: u64,
    pub nav_slot: u64,
    pub nav_max_staleness_slots: u64,
    /// Largest move a single NAV post may make, in bps. The main brake on a
    /// buggy or hostile manager: a wrong NAV can mis-price new deposits, but it
    /// cannot be moved far enough in one step to drain the vault, and existing
    /// holders can always leave in-kind at true value.
    pub nav_max_move_bps: u16,

    pub performance_fee_bps: u16,
    /// Protocol skim on withdrawals, in bps, taken in shares.
    ///
    /// Snapshotted from the platform at listing rather than read live, so the
    /// fee a depositor agreed to when they deposited is the fee they pay when
    /// they leave. The authority may ratchet it down, never up.
    pub withdraw_fee_bps: u16,
    /// Share of the vault the leader must retain while others are invested.
    pub leader_min_bps: u16,

    pub asset_count: u16,
    /// Open in-kind claims. Trading is blocked while any are outstanding, so
    /// balances cannot move between a share burn and its asset payouts.
    pub pending_claims: u32,
    pub paused: bool,
}

impl Vault {
    pub fn signer_seeds<'a>(leader: &'a Pubkey, bump: &'a [u8; 1]) -> [&'a [u8]; 3] {
        [VAULT_SEED, leader.as_ref(), bump]
    }

    pub fn assert_nav_fresh(&self, now_slot: u64) -> Result<()> {
        require!(self.nav_quote > 0, VaultError::NavNotSet);
        let age = now_slot.saturating_sub(self.nav_slot);
        require!(age <= self.nav_max_staleness_slots, VaultError::StaleNav);
        Ok(())
    }
}

/// One registered tradable asset. The index is stable for the life of the vault
/// and is what withdrawal-claim bitmaps refer to.
#[account]
#[derive(InitSpace)]
pub struct VaultAsset {
    pub vault: Pubkey,
    pub mint: Pubkey,
    pub index: u16,
    pub bump: u8,
}

/// A deposit waiting for the manager to post a fresh NAV.
///
/// Deposits are queued rather than instant because minting shares requires a
/// price, and the vault may be holding tokens no oracle covers. The quote sits
/// in a separate pending account so it is not counted in the NAV it is about to
/// be priced against.
#[account]
#[derive(InitSpace)]
pub struct DepositRequest {
    pub vault: Pubkey,
    pub owner: Pubkey,
    pub amount_quote: u64,
    pub created_slot: u64,
    pub bump: u8,
}

/// An in-kind withdrawal in progress.
///
/// Shares burn immediately and atomically, fixing the fraction owed. Assets are
/// then drawn one at a time, because paying out a slice of every holding does
/// not fit in a single transaction's account budget.
#[account]
#[derive(InitSpace)]
pub struct WithdrawalClaim {
    pub vault: Pubkey,
    pub owner: Pubkey,
    pub shares_burned: u64,
    /// Share supply *before* the burn. The payout fraction is
    /// `shares_burned / total_shares_at_burn` and cannot drift afterwards.
    pub total_shares_at_burn: u64,
    pub asset_count_at_burn: u16,
    pub assets_claimed: u16,
    pub claimed_bitmap: [u8; CLAIM_BITMAP_BYTES],
    pub bump: u8,
}

impl WithdrawalClaim {
    pub fn is_claimed(&self, index: u16) -> bool {
        let (byte, bit) = (index as usize / 8, index as usize % 8);
        self.claimed_bitmap[byte] & (1 << bit) != 0
    }

    pub fn mark_claimed(&mut self, index: u16) -> Result<()> {
        require!(!self.is_claimed(index), VaultError::AssetAlreadyClaimed);
        let (byte, bit) = (index as usize / 8, index as usize % 8);
        self.claimed_bitmap[byte] |= 1 << bit;
        self.assets_claimed = self
            .assets_claimed
            .checked_add(1)
            .ok_or(VaultError::MathOverflow)?;
        Ok(())
    }

    pub fn is_complete(&self) -> bool {
        self.assets_claimed >= self.asset_count_at_burn
    }
}

/// floor(a * b / c) in u128, for share and payout maths.
///
/// Always rounds down so residual dust stays in the vault, where it belongs to
/// the remaining holders rather than to whoever happened to round up.
pub fn mul_div_floor(a: u64, b: u64, c: u64) -> Result<u64> {
    require!(c != 0, VaultError::MathOverflow);
    let v = (a as u128)
        .checked_mul(b as u128)
        .ok_or(VaultError::MathOverflow)?
        / (c as u128);
    u64::try_from(v).map_err(|_| VaultError::MathOverflow.into())
}
