/**
 * Schema, applied idempotently at boot.
 *
 * MariaDB, so the log is queryable from outside this add-on and survives it
 * being uninstalled — for a record of who opened which door, both matter more
 * than the convenience of a file in `/data`.
 *
 * Three dialect notes that explain the column choices:
 *
 * - **Indexed strings are `VARCHAR(191)`, not `TEXT`.** InnoDB caps an index
 *   key at 3072 bytes and utf8mb4 costs 4 bytes per character, so the dedupe
 *   index below has a real budget to stay inside. 191 is the familiar ceiling
 *   and leaves room for the rest of the key.
 * - **Timestamps are `DATETIME(3)` in UTC.** Millisecond precision because the
 *   state echo and its command land within the same second, and UTC because
 *   the connection is pinned to it (see `connectDatabase`) — a server whose
 *   session timezone drifts would otherwise silently reinterpret every row.
 * - **`attributes_hash` is `CHAR(64) CHARACTER SET ascii`.** It is a hex
 *   digest, so a 4-byte charset would quadruple its index cost for nothing.
 */

export const SCHEMA = [
`
-- One row per command this service issued: the attribution trail.
CREATE TABLE IF NOT EXISTS command_log (
    command_id        VARCHAR(64)  NOT NULL,
    house_id          VARCHAR(191) NOT NULL,
    domain            VARCHAR(64)  NOT NULL,
    entity_slug       VARCHAR(191) NOT NULL,
    entity_id         VARCHAR(191) NOT NULL,
    command           VARCHAR(128) NOT NULL,
    parameters        JSON         NULL,
    actor_label       VARCHAR(128) NOT NULL,
    actor_email       VARCHAR(191) NULL,
    issued_at         DATETIME(3)  NOT NULL,
    -- issued -> confirmed | executed | accepted | failed. A row stuck at
    -- 'issued' means the process died between publishing and settling, which
    -- is itself worth being able to see.
    status            VARCHAR(20)  NOT NULL,
    reason            VARCHAR(191) NULL,
    resulting_state   VARCHAR(64)  NULL,
    publish_ms        INT          NULL,
    ack_ms            INT          NULL,
    state_echo_ms     INT          NULL,
    settled_at        DATETIME(3)  NULL,
    PRIMARY KEY (command_id),
    KEY command_log_house_issued_idx  (house_id, issued_at),
    KEY command_log_entity_issued_idx (entity_id, issued_at),
    KEY command_log_actor_issued_idx  (actor_label, issued_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
`,
`
-- Every state the bridge published, whoever caused it. Physical buttons, HA
-- automations and the Turzi app never touch this API, so the state stream is
-- the only place they are visible at all.
CREATE TABLE IF NOT EXISTS state_log (
    id                BIGINT       NOT NULL AUTO_INCREMENT,
    house_id          VARCHAR(191) NOT NULL,
    domain            VARCHAR(64)  NOT NULL,
    entity_slug       VARCHAR(191) NOT NULL,
    entity_id         VARCHAR(191) NOT NULL,
    state             VARCHAR(64)  NOT NULL,
    attributes        JSON         NOT NULL,
    -- Hash of the attributes payload, computed by the writer. It exists so the
    -- dedupe key can include attributes without indexing an unbounded blob.
    attributes_hash   CHAR(64) CHARACTER SET ascii NOT NULL,
    last_changed      DATETIME(3)  NOT NULL,
    origin_type       VARCHAR(32)  NOT NULL DEFAULT 'unknown',
    origin_command_id VARCHAR(64)  NULL,
    observed_at       DATETIME(3)  NOT NULL,
    PRIMARY KEY (id),

    -- Idempotency is mandatory, not an optimization: retained state replays on
    -- EVERY reconnect and QoS 1 re-delivers, so without this one flaky link
    -- turns into thousands of phantom rows. Enforced here rather than in
    -- process memory because process memory resets on restart, which is
    -- exactly when the replay storm arrives (PROTOCOL.md — Event-Sourcing the
    -- State Stream).
    --
    -- The attribute hash is part of the key on purpose. Deduping on
    -- last_changed alone would be the v2 ledger's rule, but v2 is recording
    -- transitions; this service is recording everything, and a cover
    -- travelling from 0 to 100 holds one last_changed across every
    -- intermediate position. Hashing the attributes keeps the movement and
    -- still collapses an identical replayed payload.
    UNIQUE KEY state_log_dedupe_idx (house_id, entity_id, last_changed, state, attributes_hash),

    KEY state_log_entity_observed_idx (entity_id, observed_at),
    KEY state_log_house_observed_idx  (house_id, observed_at),
    KEY state_log_command_idx         (origin_command_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
`,
`
-- House reachability, so a gap in the state log can be explained rather than
-- guessed at.
CREATE TABLE IF NOT EXISTS availability_log (
    id           BIGINT       NOT NULL AUTO_INCREMENT,
    house_id     VARCHAR(191) NOT NULL,
    state        VARCHAR(32)  NOT NULL,
    reason       VARCHAR(191) NULL,
    -- Receipt time, deliberately: the 'online' payload carries the core's
    -- clock but the LWT 'offline' is broker-emitted with no timestamp at all,
    -- and mixing the two inverts orderings within a second.
    observed_at  DATETIME(3)  NOT NULL,
    PRIMARY KEY (id),
    KEY availability_log_house_observed_idx (house_id, observed_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
`,
];
