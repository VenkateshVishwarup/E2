CREATE TABLE events (
  id              BIGSERIAL   PRIMARY KEY,
  tenant_id       TEXT        NOT NULL,
  lead_id         TEXT        NOT NULL,
  journey         TEXT        NOT NULL,
  journey_version INT         NOT NULL,
  agent_id        TEXT        NOT NULL,
  type            TEXT        NOT NULL,
  payload         JSONB       NOT NULL,
  occurred_at     TIMESTAMPTZ NOT NULL,
  recorded_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX events_lead_idx    ON events (tenant_id, lead_id, occurred_at);
CREATE INDEX events_journey_idx ON events (tenant_id, journey, journey_version, type);
CREATE INDEX events_agent_idx   ON events (tenant_id, agent_id, occurred_at);
CREATE INDEX events_payload_idx ON events USING GIN (payload);
