use anchor_lang::prelude::*;

use crate::errors::VaultError;

pub const PLATFORM_SEED: &[u8] = b"platform";

/// Hard ceiling on the protocol's withdrawal fee, enforced in code rather than
/// config.
///
/// The platform authority is a key, and a key can be lost, coerced or simply
/// wrong. Every parameter it controls is therefore bounded by a constant that
/// only a program upgrade can move, so the worst a compromised authority can do
/// to an existing depositor is charge 2% on the way out — not 100%.
pub const MAX_WITHDRAW_FEE_BPS: u16 = 200;

/// FOMV's platform config: one account, one authority, two revenue lines.
///
/// Vaults bind to this at listing and snapshot the fee they were listed under,
/// so a later parameter change cannot reprice an exit that depositors have
/// already underwritten.
#[account]
#[derive(InitSpace)]
pub struct Platform {
    pub bump: u8,
    /// May update parameters and hand over authority. Never touches vault funds.
    pub authority: Pubkey,
    /// Receives listing fees in SOL and withdrawal fees as vault shares.
    pub treasury: Pubkey,

    /// Skim on withdrawals, taken in shares. Applies to vaults listed from now
    /// on; existing vaults keep the figure they were listed under.
    pub withdraw_fee_bps: u16,
    /// One-off charge to list a trader on the platform, in lamports.
    pub listing_fee_lamports: u64,

    /// Vaults listed to date. Monotonic; doubles as the listing ordinal.
    pub vault_count: u64,
    /// Halts new listings. Does not touch live vaults — depositors in an
    /// existing vault can always still withdraw.
    pub listings_paused: bool,
}

impl Platform {
    pub fn signer_seeds(bump: &[u8; 1]) -> [&[u8]; 2] {
        [PLATFORM_SEED, bump]
    }

    pub fn validate_fee(withdraw_fee_bps: u16) -> Result<()> {
        require!(
            withdraw_fee_bps <= MAX_WITHDRAW_FEE_BPS,
            VaultError::WithdrawFeeTooHigh
        );
        Ok(())
    }
}
