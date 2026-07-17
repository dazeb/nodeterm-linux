create table relay_accounts (
  id uuid primary key,
  github_user_id text unique not null,
  github_login text not null,
  created_at timestamptz not null default now()
);

create table relay_sessions (
  id uuid primary key,
  account_id uuid not null references relay_accounts(id),
  token_hash text unique not null,
  expires_at timestamptz not null,
  revoked_at timestamptz,
  created_at timestamptz not null default now()
);

create table relay_invites (
  id uuid primary key,
  account_id uuid not null references relay_accounts(id),
  token_hash text unique not null,
  expires_at timestamptz not null,
  claimed_at timestamptz,
  closed_at timestamptz,
  created_at timestamptz not null default now()
);

create index relay_invites_active_account on relay_invites(account_id, expires_at) where closed_at is null;
create index relay_invites_claimable on relay_invites(token_hash, expires_at) where claimed_at is null and closed_at is null;

create table relay_invite_mints (
  account_id uuid not null references relay_accounts(id),
  minted_at timestamptz not null default now()
);

create index relay_invite_mints_window on relay_invite_mints(account_id, minted_at);
