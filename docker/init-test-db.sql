-- The compose file's POSTGRES_DB creates `midfunnel_dev`. The test suite uses a
-- separate database so a test run cannot truncate the data you were looking at
-- in the console a moment ago — but nothing created it, so `npm run db:up &&
-- npm test` failed on any machine without the container's old volume, with 16
-- files erroring before a single test ran.
--
-- Everything in this directory runs once, when the data directory is first
-- initialised.
CREATE DATABASE midfunnel_test OWNER midfunnel;
