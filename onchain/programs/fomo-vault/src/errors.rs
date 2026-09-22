use anchor_lang::prelude::*;

#[error_code]
pub enum VaultError {
    #[msg("Vault is paused")]
    Paused,
    #[msg("Only the vault manager may perform this action")]
    NotManager,
    #[msg("Posted NAV is stale; post a fresh NAV before settling")]
    StaleNav,
    #[msg("Posted NAV moved further than the configured band allows")]
    NavMoveTooLarge,
    #[msg("NAV must be positive once the vault has issued shares")]
    NavNotSet,
    #[msg("Deposit amount must be greater than zero")]
    ZeroDeposit,
    #[msg("Deposit is too small to mint a whole share at the current NAV")]
    DepositDustsToZero,
    #[msg("Share amount must be greater than zero")]
    ZeroShares,
    #[msg("Trading is blocked while in-kind withdrawal claims are open")]
    ClaimsOpen,
    #[msg("Asset is already registered on this vault")]
    AssetAlreadyRegistered,
    #[msg("Asset registry is full")]
    AssetRegistryFull,
    #[msg("This asset has already been claimed for this withdrawal")]
    AssetAlreadyClaimed,
    #[msg("Withdrawal claim still has unclaimed assets")]
    ClaimIncomplete,
    #[msg("The leader must retain the configured minimum share of the vault")]
    LeaderMinimumBreached,
    #[msg("Swap did not return at least the requested minimum output")]
    SlippageExceeded,
    #[msg("Swap spent more of the input token than authorised")]
    InputOverspend,
    #[msg("Swap must be routed through the configured aggregator program")]
    UnexpectedSwapProgram,
    #[msg("Token account is not owned by this vault")]
    ForeignTokenAccount,
    #[msg("Arithmetic overflow")]
    MathOverflow,
    #[msg("Basis-point value must not exceed 10000")]
    InvalidBps,
    #[msg("Withdrawal fee exceeds the protocol ceiling")]
    WithdrawFeeTooHigh,
    #[msg("The platform withdrawal fee may only be lowered, never raised")]
    WithdrawFeeNotLowered,
    #[msg("Only the platform authority may perform this action")]
    NotPlatformAuthority,
    #[msg("New listings are paused")]
    ListingsPaused,
    #[msg("Listing fee is higher than the maximum the lister authorised")]
    ListingFeeTooHigh,
    #[msg("This vault belongs to a different platform")]
    PlatformMismatch,
    #[msg("Withdrawal is too small to leave anything after the protocol fee")]
    WithdrawalDustsToZero,
}
