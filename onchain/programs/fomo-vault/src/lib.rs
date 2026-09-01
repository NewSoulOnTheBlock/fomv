//! Trustless in-kind copy-trading vaults for fomo leaders.
//!
//! # The design problem
//!
//! A vault that mirrors a fomo trader holds whatever they hold, which on Solana
//! means arbitrary tokens with no oracle behind them. Minting shares needs a
//! price for the whole book, and there is no honest on-chain way to price a
//! two-hour-old launch. Get that wrong and the vault becomes a free-money
//! machine: mis-price NAV, mint cheap shares, redeem at true value.
//!
//! # The resolution
//!
//! Split the two directions, because they do not have the same requirements.
//!
//! * **Exits are in-kind and never priced.** Burning X% of the shares pays out
//!   X% of *every* token the vault holds. No oracle, nothing to game, and the
//!   vault is solvent by construction because it only ever pays out fractions
//!   of what it actually has.
//! * **Entries are queued and priced by a posted NAV.** This is the one place
//!   trust enters, and it is fenced: the NAV may only move within a band per
//!   post, it goes stale, the leader must keep skin in the game, and anyone who
//!   dislikes the price can leave in-kind at true value.
//!
//! So a bad NAV can mis-price new deposits. It cannot drain the vault.

use anchor_lang::prelude::*;
use anchor_lang::solana_program::instruction::{AccountMeta, Instruction};
use anchor_lang::solana_program::program::invoke_signed;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token_interface::{
    self, Burn, Mint, MintTo, TokenAccount, TokenInterface, TransferChecked,
};

pub mod errors;
pub mod state;

use errors::VaultError;
use state::*;

declare_id!("CQL7yivcTc7sgTU4JKSYn6NRVbzmNFqChC8wH37sVq34");

/// Jupiter v6 aggregator. Trades must route through it, so the vault inherits
/// its routing and MEV protection instead of trusting the manager's venue pick.
pub mod jupiter {
    use anchor_lang::prelude::*;
    declare_id!("JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4");
}

#[program]
pub mod fomo_vault {
    use super::*;

    pub fn initialize_vault(
        ctx: Context<InitializeVault>,
        name: [u8; 32],
        nav_max_staleness_slots: u64,
        nav_max_move_bps: u16,
        performance_fee_bps: u16,
        leader_min_bps: u16,
    ) -> Result<()> {
        require!(nav_max_move_bps <= 10_000, VaultError::InvalidBps);
        require!(performance_fee_bps <= 5_000, VaultError::InvalidBps);
        require!(leader_min_bps <= 10_000, VaultError::InvalidBps);

        let vault = &mut ctx.accounts.vault;
        vault.bump = ctx.bumps.vault;
        vault.name = name;
        vault.leader = ctx.accounts.leader.key();
        vault.manager = ctx.accounts.manager.key();
        vault.quote_mint = ctx.accounts.quote_mint.key();
        vault.share_mint = ctx.accounts.share_mint.key();
        vault.nav_quote = 0;
        vault.nav_slot = 0;
        vault.nav_max_staleness_slots = nav_max_staleness_slots;
        vault.nav_max_move_bps = nav_max_move_bps;
        vault.performance_fee_bps = performance_fee_bps;
        vault.leader_min_bps = leader_min_bps;
        vault.pending_claims = 0;
        vault.paused = false;

        // The quote token is asset 0. Registering it like any other holding
        // means in-kind withdrawals hand out the idle USDC by the same code
        // path as everything else, with no special case to get wrong.
        let asset = &mut ctx.accounts.quote_asset;
        asset.vault = vault.key();
        asset.mint = vault.quote_mint;
        asset.index = 0;
        asset.bump = ctx.bumps.quote_asset;
        vault.asset_count = 1;

        Ok(())
    }

    /// Register a mint before the vault may hold it.
    ///
    /// Registration assigns a permanent index, which is what withdrawal claims
    /// tick off in their bitmaps. Without a stable index there is no way to
    /// prove an in-kind claim drew each asset exactly once.
    pub fn register_asset(ctx: Context<RegisterAsset>) -> Result<()> {
        let vault = &mut ctx.accounts.vault;
        require!(!vault.paused, VaultError::Paused);
        require!(vault.asset_count < MAX_ASSETS, VaultError::AssetRegistryFull);

        let asset = &mut ctx.accounts.asset;
        asset.vault = vault.key();
        asset.mint = ctx.accounts.mint.key();
        asset.index = vault.asset_count;
        asset.bump = ctx.bumps.asset;

        vault.asset_count = vault
            .asset_count
            .checked_add(1)
            .ok_or(VaultError::MathOverflow)?;
        Ok(())
    }

    /// Publish the vault's total value in quote units, excluding pending deposits.
    ///
    /// The band check is what makes a posted price survivable. A manager who is
    /// wrong, buggy or hostile can nudge the entry price; they cannot restate
    /// the vault's worth in one step.
    pub fn post_nav(ctx: Context<PostNav>, nav_quote: u64) -> Result<()> {
        let vault = &mut ctx.accounts.vault;
        require!(!vault.paused, VaultError::Paused);

        let supply = ctx.accounts.share_mint.supply;
        if supply > 0 && vault.nav_quote > 0 {
            let old = vault.nav_quote as u128;
            let new = nav_quote as u128;
            let delta = if new > old { new - old } else { old - new };
            let allowed = old
                .checked_mul(vault.nav_max_move_bps as u128)
                .ok_or(VaultError::MathOverflow)?
                / 10_000u128;
            require!(delta <= allowed, VaultError::NavMoveTooLarge);
        }

        vault.nav_quote = nav_quote;
        vault.nav_slot = Clock::get()?.slot;
        Ok(())
    }

    /// Queue a deposit. Quote moves to a pending account that NAV excludes.
    pub fn request_deposit(ctx: Context<RequestDeposit>, amount: u64) -> Result<()> {
        require!(amount > 0, VaultError::ZeroDeposit);
        require!(!ctx.accounts.vault.paused, VaultError::Paused);

        token_interface::transfer_checked(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                TransferChecked {
                    from: ctx.accounts.depositor_quote.to_account_info(),
                    mint: ctx.accounts.quote_mint.to_account_info(),
                    to: ctx.accounts.pending_quote.to_account_info(),
                    authority: ctx.accounts.depositor.to_account_info(),
                },
            ),
            amount,
            ctx.accounts.quote_mint.decimals,
        )?;

        let req = &mut ctx.accounts.request;
        req.vault = ctx.accounts.vault.key();
        req.owner = ctx.accounts.depositor.key();
        req.amount_quote = amount;
        req.created_slot = Clock::get()?.slot;
        req.bump = ctx.bumps.request;
        Ok(())
    }

    /// Take back a queued deposit that has not been priced yet.
    pub fn cancel_deposit(ctx: Context<CancelDeposit>) -> Result<()> {
        let amount = ctx.accounts.request.amount_quote;
        let leader = ctx.accounts.vault.leader;
        let bump = [ctx.accounts.vault.bump];
        let seeds = Vault::signer_seeds(&leader, &bump);

        token_interface::transfer_checked(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                TransferChecked {
                    from: ctx.accounts.pending_quote.to_account_info(),
                    mint: ctx.accounts.quote_mint.to_account_info(),
                    to: ctx.accounts.depositor_quote.to_account_info(),
                    authority: ctx.accounts.vault.to_account_info(),
                },
                &[&seeds],
            ),
            amount,
            ctx.accounts.quote_mint.decimals,
        )?;
        Ok(())
    }

    /// Price a queued deposit against the posted NAV and mint its shares.
    ///
    /// Permissionless on purpose: the freshness and band checks are what make
    /// the price acceptable, not who submitted the transaction. Anyone may
    /// crank a depositor in once a valid NAV exists.
    pub fn settle_deposit(ctx: Context<SettleDeposit>) -> Result<()> {
        let vault_key = ctx.accounts.vault.key();
        require!(!ctx.accounts.vault.paused, VaultError::Paused);

        let supply = ctx.accounts.share_mint.supply;
        let amount = ctx.accounts.request.amount_quote;

        let shares = if supply == 0 {
            // First money in sets the peg: one share per quote unit, so every
            // later number on a statement is legible to a human.
            amount
        } else {
            ctx.accounts.vault.assert_nav_fresh(Clock::get()?.slot)?;
            mul_div_floor(amount, supply, ctx.accounts.vault.nav_quote)?
        };
        require!(shares > 0, VaultError::DepositDustsToZero);

        let leader = ctx.accounts.vault.leader;
        let bump = [ctx.accounts.vault.bump];
        let seeds = Vault::signer_seeds(&leader, &bump);

        // Pending quote joins the working book.
        token_interface::transfer_checked(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                TransferChecked {
                    from: ctx.accounts.pending_quote.to_account_info(),
                    mint: ctx.accounts.quote_mint.to_account_info(),
                    to: ctx.accounts.vault_quote.to_account_info(),
                    authority: ctx.accounts.vault.to_account_info(),
                },
                &[&seeds],
            ),
            amount,
            ctx.accounts.quote_mint.decimals,
        )?;

        token_interface::mint_to(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                MintTo {
                    mint: ctx.accounts.share_mint.to_account_info(),
                    to: ctx.accounts.depositor_shares.to_account_info(),
                    authority: ctx.accounts.vault.to_account_info(),
                },
                &[&seeds],
            ),
            shares,
        )?;

        // The deposited quote is now part of the book, so NAV must grow by it.
        // Skipping this prices the *next* depositor against a NAV that omits
        // money the vault already holds, handing them free shares.
        let vault = &mut ctx.accounts.vault;
        vault.nav_quote = vault
            .nav_quote
            .checked_add(amount)
            .ok_or(VaultError::MathOverflow)?;

        emit!(DepositSettled {
            vault: vault_key,
            owner: ctx.accounts.request.owner,
            amount_quote: amount,
            shares,
            nav_quote: vault.nav_quote,
        });
        Ok(())
    }

    /// Burn shares and open an in-kind claim on a fraction of every holding.
    ///
    /// The burn is atomic and fixes the fraction; payouts follow one asset at a
    /// time because a slice of every holding does not fit in one transaction's
    /// account budget.
    pub fn initiate_withdrawal(ctx: Context<InitiateWithdrawal>, shares: u64) -> Result<()> {
        require!(shares > 0, VaultError::ZeroShares);
        let vault = &mut ctx.accounts.vault;
        require!(!vault.paused, VaultError::Paused);

        // One claim at a time, per vault.
        //
        // Payout maths is only order-independent if claims settle in the order
        // they were opened: each claim's fraction is taken against the supply
        // at *its* burn, so an out-of-order payout would overpay whoever went
        // first. Serialising is the cheap way to be provably correct, and
        // claims are permissionless to crank, so the queue drains quickly.
        require!(vault.pending_claims == 0, VaultError::ClaimsOpen);

        let supply_before = ctx.accounts.share_mint.supply;

        token_interface::burn(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                Burn {
                    mint: ctx.accounts.share_mint.to_account_info(),
                    from: ctx.accounts.owner_shares.to_account_info(),
                    authority: ctx.accounts.owner.to_account_info(),
                },
            ),
            shares,
        )?;

        let supply_after = supply_before
            .checked_sub(shares)
            .ok_or(VaultError::MathOverflow)?;

        // The leader cannot walk out from under the depositors following them.
        if ctx.accounts.owner.key() == vault.leader && supply_after > 0 {
            let leader_after = ctx
                .accounts
                .owner_shares
                .amount
                .checked_sub(shares)
                .ok_or(VaultError::MathOverflow)?;
            let required = mul_div_floor(supply_after, vault.leader_min_bps as u64, 10_000)?;
            require!(leader_after >= required, VaultError::LeaderMinimumBreached);
        }

        // The book shrinks by the same fraction, so the entry price must too.
        vault.nav_quote = if supply_before == 0 {
            0
        } else {
            mul_div_floor(vault.nav_quote, supply_after, supply_before)?
        };

        let claim = &mut ctx.accounts.claim;
        claim.vault = vault.key();
        claim.owner = ctx.accounts.owner.key();
        claim.shares_burned = shares;
        claim.total_shares_at_burn = supply_before;
        claim.asset_count_at_burn = vault.asset_count;
        claim.assets_claimed = 0;
        claim.claimed_bitmap = [0u8; CLAIM_BITMAP_BYTES];
        claim.bump = ctx.bumps.claim;

        vault.pending_claims = vault
            .pending_claims
            .checked_add(1)
            .ok_or(VaultError::MathOverflow)?;

        emit!(WithdrawalOpened {
            vault: claim.vault,
            owner: claim.owner,
            shares_burned: shares,
            total_shares_at_burn: supply_before,
            assets_to_claim: claim.asset_count_at_burn,
        });
        Ok(())
    }

    /// Draw this claim's fraction of one registered asset.
    ///
    /// Permissionless: funds always go to the claim owner's account, so anyone
    /// may pay the fees to crank a claim to completion. That matters because
    /// trading stays blocked until the claim closes, and a manager must be able
    /// to unblock themselves without the withdrawer's cooperation.
    pub fn claim_asset(ctx: Context<ClaimAsset>) -> Result<()> {
        let index = ctx.accounts.asset.index;
        let claim = &ctx.accounts.claim;
        require!(!claim.is_claimed(index), VaultError::AssetAlreadyClaimed);

        let amount = mul_div_floor(
            ctx.accounts.vault_token.amount,
            claim.shares_burned,
            claim.total_shares_at_burn,
        )?;

        if amount > 0 {
            let leader = ctx.accounts.vault.leader;
            let bump = [ctx.accounts.vault.bump];
            let seeds = Vault::signer_seeds(&leader, &bump);
            token_interface::transfer_checked(
                CpiContext::new_with_signer(
                    ctx.accounts.token_program.to_account_info(),
                    TransferChecked {
                        from: ctx.accounts.vault_token.to_account_info(),
                        mint: ctx.accounts.mint.to_account_info(),
                        to: ctx.accounts.owner_token.to_account_info(),
                        authority: ctx.accounts.vault.to_account_info(),
                    },
                    &[&seeds],
                ),
                amount,
                ctx.accounts.mint.decimals,
            )?;
        }

        // A zero balance still counts as claimed: the claim is complete when
        // every asset has been *considered*, not when every asset paid out.
        ctx.accounts.claim.mark_claimed(index)?;

        if ctx.accounts.claim.is_complete() {
            let vault = &mut ctx.accounts.vault;
            vault.pending_claims = vault.pending_claims.saturating_sub(1);
        }
        Ok(())
    }

    /// Close a fully-drawn claim and return its rent.
    pub fn close_claim(ctx: Context<CloseClaim>) -> Result<()> {
        require!(ctx.accounts.claim.is_complete(), VaultError::ClaimIncomplete);
        Ok(())
    }

    /// Route a swap through Jupiter on the vault's behalf.
    ///
    /// The program deliberately does not parse the route. It checks the call
    /// goes to the aggregator, then verifies the vault's own balances moved the
    /// way they were supposed to. Validating outcomes rather than instructions
    /// means new Jupiter routes keep working without a program upgrade, while
    /// still bounding what a compromised manager can do in one call.
    pub fn execute_trade(ctx: Context<ExecuteTrade>, data: Vec<u8>, max_in: u64, min_out: u64) -> Result<()> {
        let vault = &ctx.accounts.vault;
        require!(!vault.paused, VaultError::Paused);
        require!(vault.pending_claims == 0, VaultError::ClaimsOpen);
        require!(
            ctx.accounts.swap_program.key() == jupiter::ID,
            VaultError::UnexpectedSwapProgram
        );

        let vault_key = vault.key();
        require!(
            ctx.accounts.vault_in.owner == vault_key && ctx.accounts.vault_out.owner == vault_key,
            VaultError::ForeignTokenAccount
        );

        let in_before = ctx.accounts.vault_in.amount;
        let out_before = ctx.accounts.vault_out.amount;

        let metas: Vec<AccountMeta> = ctx
            .remaining_accounts
            .iter()
            .map(|a| AccountMeta {
                pubkey: *a.key,
                // The vault PDA signs via invoke_signed rather than as a
                // transaction signer, so its meta has to be marked here.
                is_signer: a.is_signer || *a.key == vault_key,
                is_writable: a.is_writable,
            })
            .collect();

        let leader = vault.leader;
        let bump = [vault.bump];
        let seeds = Vault::signer_seeds(&leader, &bump);
        invoke_signed(
            &Instruction {
                program_id: jupiter::ID,
                accounts: metas,
                data,
            },
            ctx.remaining_accounts,
            &[&seeds],
        )?;

        ctx.accounts.vault_in.reload()?;
        ctx.accounts.vault_out.reload()?;

        let spent = in_before.saturating_sub(ctx.accounts.vault_in.amount);
        let received = ctx.accounts.vault_out.amount.saturating_sub(out_before);
        require!(spent <= max_in, VaultError::InputOverspend);
        require!(received >= min_out, VaultError::SlippageExceeded);

        emit!(TradeExecuted {
            vault: vault_key,
            mint_in: ctx.accounts.vault_in.mint,
            mint_out: ctx.accounts.vault_out.mint,
            spent,
            received,
        });
        Ok(())
    }

    pub fn set_paused(ctx: Context<ManagerOnly>, paused: bool) -> Result<()> {
        ctx.accounts.vault.paused = paused;
        Ok(())
    }

    pub fn set_manager(ctx: Context<ManagerOnly>, new_manager: Pubkey) -> Result<()> {
        ctx.accounts.vault.manager = new_manager;
        Ok(())
    }
}

// ---------------------------------------------------------------------------
// Accounts
// ---------------------------------------------------------------------------

#[derive(Accounts)]
pub struct InitializeVault<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    /// CHECK: identity of the mirrored trader; never signs, never authorises.
    pub leader: UncheckedAccount<'info>,
    /// CHECK: crank authority, stored and checked on privileged instructions.
    pub manager: UncheckedAccount<'info>,

    #[account(
        init,
        payer = payer,
        space = 8 + Vault::INIT_SPACE,
        seeds = [VAULT_SEED, leader.key().as_ref()],
        bump
    )]
    pub vault: Account<'info, Vault>,

    pub quote_mint: InterfaceAccount<'info, Mint>,

    #[account(
        init,
        payer = payer,
        seeds = [SHARE_MINT_SEED, vault.key().as_ref()],
        bump,
        mint::decimals = 6,
        mint::authority = vault,
        mint::token_program = token_program,
    )]
    pub share_mint: InterfaceAccount<'info, Mint>,

    #[account(
        init,
        payer = payer,
        space = 8 + VaultAsset::INIT_SPACE,
        seeds = [ASSET_SEED, vault.key().as_ref(), quote_mint.key().as_ref()],
        bump
    )]
    pub quote_asset: Account<'info, VaultAsset>,

    #[account(
        init,
        payer = payer,
        associated_token::mint = quote_mint,
        associated_token::authority = vault,
        associated_token::token_program = token_program,
    )]
    pub vault_quote: InterfaceAccount<'info, TokenAccount>,

    #[account(
        init,
        payer = payer,
        seeds = [PENDING_SEED, vault.key().as_ref()],
        bump,
        token::mint = quote_mint,
        token::authority = vault,
        token::token_program = token_program,
    )]
    pub pending_quote: InterfaceAccount<'info, TokenAccount>,

    pub token_program: Interface<'info, TokenInterface>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct RegisterAsset<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(constraint = manager.key() == vault.manager @ VaultError::NotManager)]
    pub manager: Signer<'info>,
    #[account(mut, seeds = [VAULT_SEED, vault.leader.as_ref()], bump = vault.bump)]
    pub vault: Account<'info, Vault>,
    pub mint: InterfaceAccount<'info, Mint>,
    #[account(
        init,
        payer = payer,
        space = 8 + VaultAsset::INIT_SPACE,
        seeds = [ASSET_SEED, vault.key().as_ref(), mint.key().as_ref()],
        bump
    )]
    pub asset: Account<'info, VaultAsset>,
    #[account(
        init_if_needed,
        payer = payer,
        associated_token::mint = mint,
        associated_token::authority = vault,
        associated_token::token_program = token_program,
    )]
    pub vault_token: InterfaceAccount<'info, TokenAccount>,
    pub token_program: Interface<'info, TokenInterface>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct PostNav<'info> {
    #[account(constraint = manager.key() == vault.manager @ VaultError::NotManager)]
    pub manager: Signer<'info>,
    #[account(mut, seeds = [VAULT_SEED, vault.leader.as_ref()], bump = vault.bump)]
    pub vault: Account<'info, Vault>,
    #[account(address = vault.share_mint)]
    pub share_mint: InterfaceAccount<'info, Mint>,
}

#[derive(Accounts)]
pub struct RequestDeposit<'info> {
    #[account(mut)]
    pub depositor: Signer<'info>,
    #[account(seeds = [VAULT_SEED, vault.leader.as_ref()], bump = vault.bump)]
    pub vault: Account<'info, Vault>,
    #[account(address = vault.quote_mint)]
    pub quote_mint: InterfaceAccount<'info, Mint>,
    #[account(mut, token::mint = quote_mint, token::authority = depositor)]
    pub depositor_quote: InterfaceAccount<'info, TokenAccount>,
    #[account(mut, seeds = [PENDING_SEED, vault.key().as_ref()], bump)]
    pub pending_quote: InterfaceAccount<'info, TokenAccount>,
    #[account(
        init,
        payer = depositor,
        space = 8 + DepositRequest::INIT_SPACE,
        seeds = [DEPOSIT_SEED, vault.key().as_ref(), depositor.key().as_ref()],
        bump
    )]
    pub request: Account<'info, DepositRequest>,
    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct CancelDeposit<'info> {
    #[account(mut)]
    pub depositor: Signer<'info>,
    #[account(seeds = [VAULT_SEED, vault.leader.as_ref()], bump = vault.bump)]
    pub vault: Account<'info, Vault>,
    #[account(address = vault.quote_mint)]
    pub quote_mint: InterfaceAccount<'info, Mint>,
    #[account(mut, token::mint = quote_mint, token::authority = depositor)]
    pub depositor_quote: InterfaceAccount<'info, TokenAccount>,
    #[account(mut, seeds = [PENDING_SEED, vault.key().as_ref()], bump)]
    pub pending_quote: InterfaceAccount<'info, TokenAccount>,
    #[account(
        mut,
        close = depositor,
        has_one = vault,
        constraint = request.owner == depositor.key(),
        seeds = [DEPOSIT_SEED, vault.key().as_ref(), depositor.key().as_ref()],
        bump = request.bump
    )]
    pub request: Account<'info, DepositRequest>,
    pub token_program: Interface<'info, TokenInterface>,
}

#[derive(Accounts)]
pub struct SettleDeposit<'info> {
    /// CHECK: permissionless crank; pays fees and receives the request's rent.
    #[account(mut)]
    pub cranker: Signer<'info>,
    #[account(mut, seeds = [VAULT_SEED, vault.leader.as_ref()], bump = vault.bump)]
    pub vault: Account<'info, Vault>,
    #[account(mut, address = vault.share_mint)]
    pub share_mint: InterfaceAccount<'info, Mint>,
    #[account(address = vault.quote_mint)]
    pub quote_mint: InterfaceAccount<'info, Mint>,
    #[account(mut, seeds = [PENDING_SEED, vault.key().as_ref()], bump)]
    pub pending_quote: InterfaceAccount<'info, TokenAccount>,
    #[account(
        mut,
        associated_token::mint = quote_mint,
        associated_token::authority = vault,
        associated_token::token_program = token_program,
    )]
    pub vault_quote: InterfaceAccount<'info, TokenAccount>,
    /// CHECK: the depositor named by the request; receives shares and rent.
    #[account(mut, address = request.owner)]
    pub depositor: UncheckedAccount<'info>,
    #[account(
        init_if_needed,
        payer = cranker,
        associated_token::mint = share_mint,
        associated_token::authority = depositor,
        associated_token::token_program = token_program,
    )]
    pub depositor_shares: InterfaceAccount<'info, TokenAccount>,
    #[account(
        mut,
        close = depositor,
        has_one = vault,
        seeds = [DEPOSIT_SEED, vault.key().as_ref(), request.owner.as_ref()],
        bump = request.bump
    )]
    pub request: Account<'info, DepositRequest>,
    pub token_program: Interface<'info, TokenInterface>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct InitiateWithdrawal<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(mut, seeds = [VAULT_SEED, vault.leader.as_ref()], bump = vault.bump)]
    pub vault: Account<'info, Vault>,
    #[account(mut, address = vault.share_mint)]
    pub share_mint: InterfaceAccount<'info, Mint>,
    #[account(mut, token::mint = share_mint, token::authority = owner)]
    pub owner_shares: InterfaceAccount<'info, TokenAccount>,
    #[account(
        init,
        payer = owner,
        space = 8 + WithdrawalClaim::INIT_SPACE,
        seeds = [CLAIM_SEED, vault.key().as_ref(), owner.key().as_ref()],
        bump
    )]
    pub claim: Account<'info, WithdrawalClaim>,
    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct ClaimAsset<'info> {
    #[account(mut)]
    pub cranker: Signer<'info>,
    #[account(mut, seeds = [VAULT_SEED, vault.leader.as_ref()], bump = vault.bump)]
    pub vault: Account<'info, Vault>,
    #[account(
        mut,
        has_one = vault,
        seeds = [CLAIM_SEED, vault.key().as_ref(), claim.owner.as_ref()],
        bump = claim.bump
    )]
    pub claim: Account<'info, WithdrawalClaim>,
    #[account(
        has_one = vault,
        constraint = asset.mint == mint.key(),
        seeds = [ASSET_SEED, vault.key().as_ref(), mint.key().as_ref()],
        bump = asset.bump
    )]
    pub asset: Account<'info, VaultAsset>,
    pub mint: InterfaceAccount<'info, Mint>,
    #[account(
        mut,
        associated_token::mint = mint,
        associated_token::authority = vault,
        associated_token::token_program = token_program,
    )]
    pub vault_token: InterfaceAccount<'info, TokenAccount>,
    /// CHECK: the claim's owner; the only possible payout destination.
    #[account(mut, address = claim.owner)]
    pub owner: UncheckedAccount<'info>,
    #[account(
        init_if_needed,
        payer = cranker,
        associated_token::mint = mint,
        associated_token::authority = owner,
        associated_token::token_program = token_program,
    )]
    pub owner_token: InterfaceAccount<'info, TokenAccount>,
    pub token_program: Interface<'info, TokenInterface>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct CloseClaim<'info> {
    /// CHECK: receives the claim's rent; must be the claim owner.
    #[account(mut, address = claim.owner)]
    pub owner: UncheckedAccount<'info>,
    #[account(seeds = [VAULT_SEED, vault.leader.as_ref()], bump = vault.bump)]
    pub vault: Account<'info, Vault>,
    #[account(
        mut,
        close = owner,
        has_one = vault,
        seeds = [CLAIM_SEED, vault.key().as_ref(), claim.owner.as_ref()],
        bump = claim.bump
    )]
    pub claim: Account<'info, WithdrawalClaim>,
}

#[derive(Accounts)]
pub struct ExecuteTrade<'info> {
    #[account(constraint = manager.key() == vault.manager @ VaultError::NotManager)]
    pub manager: Signer<'info>,
    #[account(seeds = [VAULT_SEED, vault.leader.as_ref()], bump = vault.bump)]
    pub vault: Account<'info, Vault>,
    #[account(mut)]
    pub vault_in: InterfaceAccount<'info, TokenAccount>,
    #[account(mut)]
    pub vault_out: InterfaceAccount<'info, TokenAccount>,
    /// CHECK: verified against the Jupiter program id before invocation.
    pub swap_program: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct ManagerOnly<'info> {
    #[account(constraint = manager.key() == vault.manager @ VaultError::NotManager)]
    pub manager: Signer<'info>,
    #[account(mut, seeds = [VAULT_SEED, vault.leader.as_ref()], bump = vault.bump)]
    pub vault: Account<'info, Vault>,
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

#[event]
pub struct DepositSettled {
    pub vault: Pubkey,
    pub owner: Pubkey,
    pub amount_quote: u64,
    pub shares: u64,
    pub nav_quote: u64,
}

#[event]
pub struct WithdrawalOpened {
    pub vault: Pubkey,
    pub owner: Pubkey,
    pub shares_burned: u64,
    pub total_shares_at_burn: u64,
    pub assets_to_claim: u16,
}

#[event]
pub struct TradeExecuted {
    pub vault: Pubkey,
    pub mint_in: Pubkey,
    pub mint_out: Pubkey,
    pub spent: u64,
    pub received: u64,
}
