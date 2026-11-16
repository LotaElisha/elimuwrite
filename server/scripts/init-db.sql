-- Run once as a PostgreSQL superuser:  psql -U postgres -f server/scripts/init-db.sql
-- Two roles: the owner runs migrations; the app role is what the server connects as, so
-- row-level security always applies to application queries (owners bypass RLS).
-- Change the passwords for any shared or production environment.
create role elimu_owner login password 'elimu_owner';
create role elimu_app login password 'elimu_app';
create database elimuwrite owner elimu_owner;
create database elimuwrite_test owner elimu_owner;
\connect elimuwrite
create extension if not exists pgcrypto;
create extension if not exists citext;
\connect elimuwrite_test
create extension if not exists pgcrypto;
create extension if not exists citext;
