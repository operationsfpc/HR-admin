// Storage dispatcher.
// If SUPABASE_DB_URL (or DATABASE_URL) is set -> use Supabase/Postgres (db.pg.js).
// Otherwise -> local SQLite / JSON fallback (db.sqlite.js).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Fallback .env loader: if the process wasn't started with --env-file, read
// ../.env so SUPABASE_DB_URL etc. are available. Never overwrites existing env.
(function loadDotEnv() {
  try {
    const envPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '.env');
    if (!fs.existsSync(envPath)) return;
    for (const raw of fs.readFileSync(envPath, 'utf8').split('\n')) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      const eq = line.indexOf('=');
      if (eq === -1) continue;
      const key = line.slice(0, eq).trim();
      let val = line.slice(eq + 1).trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1);
      if (key && process.env[key] === undefined) process.env[key] = val;
    }
  } catch { /* ignore */ }
})();

const useSupabase = !!(process.env.SUPABASE_DB_URL || process.env.DATABASE_URL);
console.log('[db] SUPABASE_DB_URL ' + (useSupabase ? 'detected -> using Supabase/Postgres' : 'not set -> using local SQLite'));
const impl = await import(useSupabase ? './db.pg.js' : './db.sqlite.js');

export const storageBackend = impl.storageBackend;
// Colleges
export const listColleges = impl.listColleges;
export const getCollegeByName = impl.getCollegeByName;
export const addCollege = impl.addCollege;
export const updateCollege = impl.updateCollege;
export const verifyCollegeCode = impl.verifyCollegeCode;
export const deleteCollege = impl.deleteCollege;
// Contests
export const listContests = impl.listContests;
export const getContest = impl.getContest;
export const getContestByShareToken = impl.getContestByShareToken;
export const setContestShareToken = impl.setContestShareToken;
export const addContest = impl.addContest;
export const updateContest = impl.updateContest;
export const deleteContest = impl.deleteContest;
// Contest ↔ student mapping
export const assignStudentsToContest = impl.assignStudentsToContest;
export const getContestStudentKeys = impl.getContestStudentKeys;
export const listContestsForStudent = impl.listContestsForStudent;
export const listStudentsForContest = impl.listStudentsForContest;
// Students
export const listStudents = impl.listStudents;
export const getStudent = impl.getStudent;
export const updateStudent = impl.updateStudent;
export const upsertStudents = impl.upsertStudents;
export const deleteStudents = impl.deleteStudents;
export const getStudentFacets = impl.getStudentFacets;
// Scrapes
export const saveScrape = impl.saveScrape;
export const getLatestScrape = impl.getLatestScrape;
export const getScrapeSeries = impl.getScrapeSeries;
export const pruneScrapes = impl.pruneScrapes;
// Topics / videos / categories
export const getTopics = impl.getTopics;
export const saveTopics = impl.saveTopics;
export const getTopicVideos = impl.getTopicVideos;
export const saveTopicVideos = impl.saveTopicVideos;
export const getQuestionCategories = impl.getQuestionCategories;
export const saveQuestionCategories = impl.saveQuestionCategories;
// App settings (key/value)
export const getSetting = impl.getSetting;
export const setSetting = impl.setSetting;
