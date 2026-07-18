import Database from 'better-sqlite3';
import path from 'path';

const dbPath = path.resolve(process.cwd(), 'automation.db');
const db = new Database(dbPath);

// Initialize tables
db.exec(`
  CREATE TABLE IF NOT EXISTS automation_settings (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    enabled INTEGER DEFAULT 0,
    threads TEXT DEFAULT '',
    check_hours TEXT DEFAULT '09:00,13:00,17:00,21:00',
    dm_template TEXT DEFAULT 'Merhaba {grup_ismi} grubunda yorum ve beğeni eksiğiniz var dönüş yapmak zorundasınız',
    group_report_template TEXT DEFAULT 'Beğeni/Yorum yapmayan üyeler:\n{missing_users}',
    break_minutes INTEGER DEFAULT 5,
    dm_delay_seconds INTEGER DEFAULT 30,
    comment_check_enabled INTEGER DEFAULT 1,
    like_check_enabled INTEGER DEFAULT 1,
    auto_dm_enabled INTEGER DEFAULT 1,
    auto_group_report_enabled INTEGER DEFAULT 1,
    cookies TEXT DEFAULT '',
    headers TEXT DEFAULT '',
    post_data TEXT DEFAULT '',
    scan_mode TEXT DEFAULT 'all',
    target_username TEXT DEFAULT '',
    admin_report_enabled INTEGER DEFAULT 0,
    admin_username TEXT DEFAULT '',
    scan_date TEXT DEFAULT 'yesterday',
    dm_bulk_template TEXT DEFAULT 'Merhaba {grup_ismi} grubunda eksiğiniz var dönüş yapmanız gerekiyor'
  );

  CREATE TABLE IF NOT EXISTS locked_posts (
    thread_id TEXT PRIMARY KEY,
    media_id TEXT NOT NULL,
    shortcode TEXT NOT NULL,
    lock_date TEXT NOT NULL,
    comments_disabled INTEGER DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS sent_dms (
    media_id TEXT NOT NULL,
    recipient_id TEXT NOT NULL,
    sent_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (media_id, recipient_id)
  );

  CREATE TABLE IF NOT EXISTS automation_threads (
    thread_id TEXT PRIMARY KEY,
    comment_check_enabled INTEGER DEFAULT 1,
    like_check_enabled INTEGER DEFAULT 1,
    admin_report_enabled INTEGER DEFAULT 0,
    admin_username TEXT DEFAULT '',
    scan_mode TEXT DEFAULT 'all'
  );

  CREATE TABLE IF NOT EXISTS checked_posts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    media_id TEXT NOT NULL,
    shortcode TEXT NOT NULL,
    thread_id TEXT NOT NULL,
    checked_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    likes_count INTEGER DEFAULT 0,
    comments_count INTEGER DEFAULT 0,
    missing_count INTEGER DEFAULT 0,
    dms_sent_count INTEGER DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS automation_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
    type TEXT NOT NULL, -- 'info' | 'warning' | 'error' | 'success'
    message TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS sent_messages_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    thread_id TEXT NOT NULL,
    message_id TEXT NOT NULL,
    sent_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

// Alter existing table to add scan_mode if not present
try {
  db.exec(`ALTER TABLE automation_settings ADD COLUMN scan_mode TEXT DEFAULT 'all'`);
} catch (e) {
  // Column already exists, ignore
}

// Alter existing table to add target_username if not present
try {
  db.exec(`ALTER TABLE automation_settings ADD COLUMN target_username TEXT DEFAULT ''`);
} catch (e) {
  // Column already exists, ignore
}

// Alter existing table to add admin_report_enabled if not present
try {
  db.exec(`ALTER TABLE automation_settings ADD COLUMN admin_report_enabled INTEGER DEFAULT 0`);
} catch (e) {
  // Column already exists, ignore
}

// Alter existing table to add admin_username if not present
try {
  db.exec(`ALTER TABLE automation_settings ADD COLUMN admin_username TEXT DEFAULT ''`);
} catch (e) {
  // Column already exists, ignore
}

// Alter automation_threads to add admin_report_enabled if not present
try {
  db.exec(`ALTER TABLE automation_threads ADD COLUMN admin_report_enabled INTEGER DEFAULT 0`);
} catch (e) {
  // Column already exists, ignore
}

// Alter automation_threads to add admin_username if not present
try {
  db.exec(`ALTER TABLE automation_threads ADD COLUMN admin_username TEXT DEFAULT ''`);
} catch (e) {
  // Column already exists, ignore
}

// Alter automation_threads to add scan_mode if not present
try {
  db.exec(`ALTER TABLE automation_threads ADD COLUMN scan_mode TEXT DEFAULT 'all'`);
} catch (e) {
  // Column already exists, ignore
}

// Alter automation_settings to add scan_date if not present
try {
  db.exec(`ALTER TABLE automation_settings ADD COLUMN scan_date TEXT DEFAULT 'yesterday'`);
} catch (e) {
  // Column already exists, ignore
}

// Alter automation_settings to add dm_bulk_template if not present
try {
  db.exec(`ALTER TABLE automation_settings ADD COLUMN dm_bulk_template TEXT DEFAULT 'Merhaba {grup_ismi} grubunda eksiğiniz var dönüş yapmanız gerekiyor'`);
} catch (e) {
  // Column already exists, ignore
}

// Alter automation_settings to add ai_assistant_enabled if not present
try {
  db.exec(`ALTER TABLE automation_settings ADD COLUMN ai_assistant_enabled INTEGER DEFAULT 0`);
} catch (e) {
  // Column already exists, ignore
}

// Alter automation_settings to add ai_api_key if not present
try {
  db.exec(`ALTER TABLE automation_settings ADD COLUMN ai_api_key TEXT DEFAULT ''`);
} catch (e) {
  // Column already exists, ignore
}

// Alter automation_settings to add ai_model if not present
try {
  db.exec(`ALTER TABLE automation_settings ADD COLUMN ai_model TEXT DEFAULT 'openrouter/free'`);
} catch (e) {
  // Column already exists, ignore
}

// Alter automation_settings to add ai_system_prompt if not present
try {
  db.exec(`ALTER TABLE automation_settings ADD COLUMN ai_system_prompt TEXT DEFAULT 'Sen bir Instagram grup otomasyon asistanısın. Üyelerin eksik bildirimlerine ve sorularına nazikçe ve Türkçe cevap ver.'`);
} catch (e) {
  // Column already exists, ignore
}

// Alter automation_settings to add ai_delay_seconds if not present
try {
  db.exec(`ALTER TABLE automation_settings ADD COLUMN ai_delay_seconds INTEGER DEFAULT 30`);
} catch (e) {
  // Column already exists, ignore
}

// Alter automation_settings to add exempt_usernames if not present
try {
  db.exec(`ALTER TABLE automation_settings ADD COLUMN exempt_usernames TEXT DEFAULT ''`);
} catch (e) {
  // Column already exists, ignore
}

// Insert default settings if not exists
const row = db.prepare('SELECT count(*) as count FROM automation_settings').get() as { count: number };
if (row.count === 0) {
  db.prepare(`
    INSERT INTO automation_settings (id, enabled) VALUES (1, 0)
  `).run();
}

// Update default DM template to the new format if it was using the old default, or was empty
try {
  db.prepare(`
    UPDATE automation_settings 
    SET dm_template = 'Merhaba {grup_ismi} grubunda yorum ve beğeni eksiğiniz var dönüş yapmak zorundasınız'
    WHERE dm_template = 'Merhaba @{username}, paylaşılan gönderiye beğeni/yorumlarınızı rica ederiz: {link}' 
       OR dm_template = '' 
       OR dm_template IS NULL
  `).run();
} catch (e) {
  console.error('[DB-Migration] Failed to migrate default DM template:', e);
}

export default db;
export interface AutomationSettings {
  enabled: number;
  threads: string;
  check_hours: string;
  dm_template: string;
  group_report_template: string;
  break_minutes: number;
  dm_delay_seconds: number;
  comment_check_enabled: number;
  like_check_enabled: number;
  auto_dm_enabled: number;
  auto_group_report_enabled: number;
  cookies: string;
  headers: string;
  post_data: string;
  scan_mode: string;
  target_username: string;
  admin_report_enabled: number;
  admin_username: string;
  scan_date: string;
  dm_bulk_template: string;
  ai_assistant_enabled: number;
  ai_api_key: string;
  ai_model: string;
  ai_system_prompt: string;
  ai_delay_seconds: number;
  exempt_usernames: string;
}
