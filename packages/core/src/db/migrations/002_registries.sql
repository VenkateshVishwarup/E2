CREATE TABLE journey_versions (
  tenant_id    TEXT        NOT NULL,
  journey      TEXT        NOT NULL,
  version      INT         NOT NULL,
  yaml_source  TEXT        NOT NULL,
  spec         JSONB       NOT NULL,
  published_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, journey, version)
);
