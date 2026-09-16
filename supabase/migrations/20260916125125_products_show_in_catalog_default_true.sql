-- New products join the public catalogue by default.
-- Existing rows are intentionally left untouched: this only changes the
-- default for rows inserted from now on.
alter table products alter column show_in_catalog set default true;;
