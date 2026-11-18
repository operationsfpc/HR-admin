-- =====================================================================
-- Combined schema: HackerRank Admin + LeetCode Admin in ONE database,
-- isolated by Postgres schema (namespace) so their tables never collide.
--   hackerrank.*   -> HackerRank Admin app  (DB_SCHEMA=hackerrank)
--   leetcode.*     -> LeetCode Admin app    (DB_SCHEMA=leetcode)
-- Run once in the shared Supabase project's SQL Editor. Idempotent.
-- =====================================================================

-- ---------- HackerRank ----------
CREATE SCHEMA IF NOT EXISTS hackerrank;

CREATE TABLE IF NOT EXISTS hackerrank.colleges (
  id bigint generated always as identity primary key,
  name text unique, access_code text, contest_url text, slug text, created_at timestamptz default now()
);
CREATE TABLE IF NOT EXISTS hackerrank.students (
  id bigint generated always as identity primary key,
  college text, name text, hr_username text, username_key text,
  register_no text, email text, department text, section text, year text, campus text,
  unique(college, username_key)
);
CREATE TABLE IF NOT EXISTS hackerrank.contests (
  id bigint generated always as identity primary key,
  college text, name text, contest_url text, slug text, share_token text, created_at timestamptz default now()
);
CREATE TABLE IF NOT EXISTS hackerrank.contest_students (
  contest_id bigint, username_key text, primary key(contest_id, username_key)
);
CREATE TABLE IF NOT EXISTS hackerrank.scrapes (
  id bigint generated always as identity primary key,
  slug text, contest_name text, total_users int, total_questions int, payload jsonb, created_at timestamptz default now()
);
CREATE TABLE IF NOT EXISTS hackerrank.topics (slug text, question text, topic text, primary key(slug, question));
CREATE TABLE IF NOT EXISTS hackerrank.topic_videos (slug text, topic text, video_url text, primary key(slug, topic));
CREATE TABLE IF NOT EXISTS hackerrank.question_categories (slug text, question text, category text, primary key(slug, question));
CREATE TABLE IF NOT EXISTS hackerrank.app_settings (key text primary key, value text);

CREATE INDEX IF NOT EXISTS idx_hr_students_college       ON hackerrank.students(college);
CREATE INDEX IF NOT EXISTS idx_hr_students_college_name  ON hackerrank.students(college, name);
CREATE INDEX IF NOT EXISTS idx_hr_contests_college       ON hackerrank.contests(college);
CREATE INDEX IF NOT EXISTS idx_hr_contests_share_token   ON hackerrank.contests(share_token);
CREATE INDEX IF NOT EXISTS idx_hr_contest_students       ON hackerrank.contest_students(contest_id);
CREATE INDEX IF NOT EXISTS idx_hr_scrapes_slug_id        ON hackerrank.scrapes(slug, id DESC);
CREATE INDEX IF NOT EXISTS idx_hr_topics_slug            ON hackerrank.topics(slug);
CREATE INDEX IF NOT EXISTS idx_hr_topic_videos_slug      ON hackerrank.topic_videos(slug);
CREATE INDEX IF NOT EXISTS idx_hr_qcat_slug              ON hackerrank.question_categories(slug);

-- ---------- LeetCode ----------
CREATE SCHEMA IF NOT EXISTS leetcode;

CREATE TABLE IF NOT EXISTS leetcode.colleges (
  id          bigint generated always as identity primary key,
  name        text not null unique,
  access_code text,
  view_token  text,
  created_at  timestamptz not null default now()
);
ALTER TABLE leetcode.colleges ADD COLUMN IF NOT EXISTS show_video boolean not null default true;
ALTER TABLE leetcode.colleges ADD COLUMN IF NOT EXISTS sync_mode text default 'on';
ALTER TABLE leetcode.colleges ADD COLUMN IF NOT EXISTS sync_from text;
ALTER TABLE leetcode.colleges ADD COLUMN IF NOT EXISTS sync_to text;
ALTER TABLE leetcode.colleges ADD COLUMN IF NOT EXISTS refresh_mode text default 'on';
ALTER TABLE leetcode.colleges ADD COLUMN IF NOT EXISTS refresh_from text;
ALTER TABLE leetcode.colleges ADD COLUMN IF NOT EXISTS refresh_to text;

CREATE TABLE IF NOT EXISTS leetcode.students (
  id             bigint generated always as identity primary key,
  college_id     bigint not null references leetcode.colleges(id) on delete cascade,
  name           text not null,
  username       text not null,
  profile_url    text,
  ranking        integer,
  contest_rating integer,
  solved_easy    integer default 0,
  solved_medium  integer default 0,
  solved_hard    integer default 0,
  solved_total   integer default 0,
  found          integer default 1,
  sync_status    text default 'pending',
  sync_error     text,
  last_synced_at timestamptz,
  baseline_ranking integer, baseline_easy integer, baseline_medium integer,
  baseline_hard integer, baseline_total integer, baseline_at timestamptz,
  register_number text, email text, department text, section text, year text, campus text,
  created_at     timestamptz not null default now(),
  unique (college_id, username)
);
CREATE INDEX IF NOT EXISTS idx_students_filters ON leetcode.students(college_id, section, department, campus);
CREATE INDEX IF NOT EXISTS idx_students_college ON leetcode.students(college_id);

CREATE TABLE IF NOT EXISTS leetcode.monthly_activity (
  student_id  bigint not null references leetcode.students(id) on delete cascade,
  ym          text not null,
  submissions integer not null default 0,
  college_id  bigint,
  primary key (student_id, ym)
);
CREATE INDEX IF NOT EXISTS idx_ma_student ON leetcode.monthly_activity(student_id);
CREATE INDEX IF NOT EXISTS idx_ma_college_ym ON leetcode.monthly_activity(college_id, ym);

CREATE TABLE IF NOT EXISTS leetcode.stat_snapshots (
  id          bigint generated always as identity primary key,
  student_id  bigint not null references leetcode.students(id) on delete cascade,
  taken_at    timestamptz not null default now(),
  solved_easy integer, solved_medium integer, solved_hard integer, solved_total integer
);
CREATE INDEX IF NOT EXISTS idx_snapshots_student ON leetcode.stat_snapshots(student_id);

CREATE TABLE IF NOT EXISTS leetcode.practice_problems (
  id          bigint generated always as identity primary key,
  college_id  bigint not null references leetcode.colleges(id) on delete cascade,
  title       text not null,
  slug        text not null,
  url         text not null,
  difficulty  text,
  topic       text,
  domain      text,
  video_url   text,
  due_date    text,
  created_at  timestamptz not null default now(),
  unique (college_id, slug)
);
CREATE INDEX IF NOT EXISTS idx_problems_college ON leetcode.practice_problems(college_id);

CREATE TABLE IF NOT EXISTS leetcode.practice_completions (
  student_id       bigint not null references leetcode.students(id) on delete cascade,
  problem_id       bigint not null references leetcode.practice_problems(id) on delete cascade,
  completed_at     timestamptz not null default now(),
  solved_timestamp bigint,
  primary key (student_id, problem_id)
);
CREATE INDEX IF NOT EXISTS idx_pc_student ON leetcode.practice_completions(student_id);
CREATE INDEX IF NOT EXISTS idx_pc_problem ON leetcode.practice_completions(problem_id);

CREATE TABLE IF NOT EXISTS leetcode.practice_order (
  college_id bigint not null references leetcode.colleges(id) on delete cascade,
  kind       text not null,
  name       text not null,
  position   integer not null,
  primary key (college_id, kind, name)
);

CREATE TABLE IF NOT EXISTS leetcode.app_settings (key text primary key, value text);

-- Backfill denormalized college on monthly_activity (idempotent).
UPDATE leetcode.monthly_activity m SET college_id = s.college_id
  FROM leetcode.students s WHERE s.id = m.student_id AND m.college_id IS NULL;
