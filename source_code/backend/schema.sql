-- D1 schema for ASL datasets and training jobs
CREATE TABLE IF NOT EXISTS datasets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  description TEXT,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS samples (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  dataset_id INTEGER NOT NULL,
  label TEXT NOT NULL,
  file_key TEXT NOT NULL,
  notes TEXT,
  created_at INTEGER NOT NULL,
  FOREIGN KEY(dataset_id) REFERENCES datasets(id)
) STRICT;

CREATE TABLE IF NOT EXISTS training_jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  dataset_id INTEGER NOT NULL,
  status TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY(dataset_id) REFERENCES datasets(id)
) STRICT;

CREATE INDEX IF NOT EXISTS idx_samples_dataset ON samples(dataset_id);
CREATE INDEX IF NOT EXISTS idx_jobs_dataset ON training_jobs(dataset_id);
