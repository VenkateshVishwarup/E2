-- Publishing and going live were the same act, which left no way to try a
-- version before real traffic met it. They are now separate: publishing makes a
-- version exist and be addressable; promoting makes it the one that answers by
-- default.
--
-- A table rather than a boolean column, so "exactly one live version per
-- journey" is a primary key rather than a rule someone has to remember.
CREATE TABLE journey_live (
  tenant_id   TEXT        NOT NULL,
  journey     TEXT        NOT NULL,
  version     INT         NOT NULL,
  promoted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, journey),
  FOREIGN KEY (tenant_id, journey, version)
    REFERENCES journey_versions (tenant_id, journey, version) ON DELETE CASCADE
);

-- Existing journeys keep serving what they served: the highest version, which
-- is what "live" meant before this table existed.
INSERT INTO journey_live (tenant_id, journey, version)
SELECT DISTINCT ON (tenant_id, journey) tenant_id, journey, version
FROM journey_versions
ORDER BY tenant_id, journey, version DESC;
