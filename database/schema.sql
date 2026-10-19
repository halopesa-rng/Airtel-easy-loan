-- Green Star School Management System
-- PostgreSQL bootstrap schema for v1.8.4-final-clean-reports
-- This file creates the database structure only. It does not contain real school data.
-- The application also runs compatibility migrations at startup.

BEGIN;

CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  full_name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin','director','principal','secretary','teacher','ustadh','patron','student','parent','worker')),
  phone TEXT,
  email TEXT UNIQUE,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  staff_category TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS students (
  id SERIAL PRIMARY KEY,
  admission_no TEXT NOT NULL UNIQUE,
  full_name TEXT NOT NULL,
  gender TEXT,
  date_of_birth DATE,
  class_name TEXT NOT NULL,
  stream TEXT,
  parent_name TEXT,
  parent_phone TEXT,
  user_id INT REFERENCES users(id) ON DELETE SET NULL,
  birth_certificate_number TEXT,
  assessment_number TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS subjects (
  id SERIAL PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL UNIQUE,
  max_marks NUMERIC(8,2) NOT NULL DEFAULT 100,
  levels TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS exams (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  term TEXT NOT NULL,
  academic_year INT NOT NULL,
  exam_date DATE,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS marks (
  id SERIAL PRIMARY KEY,
  exam_id INT NOT NULL REFERENCES exams(id) ON DELETE CASCADE,
  student_id INT NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  subject_id INT NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
  marks NUMERIC(8,2) NOT NULL DEFAULT 0,
  grade TEXT,
  teacher_comment TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
  UNIQUE(exam_id,student_id,subject_id)
);

CREATE TABLE IF NOT EXISTS fee_records (
  id SERIAL PRIMARY KEY,
  student_id INT NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  receipt_no TEXT NOT NULL UNIQUE,
  description TEXT NOT NULL DEFAULT 'School fees payment',
  amount NUMERIC(12,2) NOT NULL DEFAULT 0,
  payment_method TEXT NOT NULL DEFAULT 'Cash',
  reference TEXT,
  created_by INT REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS fee_charges (
  id SERIAL PRIMARY KEY,
  student_id INT NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  academic_year INT NOT NULL,
  term TEXT NOT NULL,
  description TEXT NOT NULL,
  amount NUMERIC(12,2) NOT NULL DEFAULT 0,
  period_type TEXT DEFAULT 'monthly',
  fee_month TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS announcements (
  id SERIAL PRIMARY KEY,
  title TEXT NOT NULL,
  message TEXT NOT NULL,
  audience TEXT NOT NULL DEFAULT 'all',
  created_by INT REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS assets (
  id SERIAL PRIMARY KEY,
  asset_code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  category TEXT,
  quantity INT NOT NULL DEFAULT 1,
  condition TEXT DEFAULT 'Good',
  location TEXT,
  purchase_date DATE,
  purchase_value NUMERIC(12,2) NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'Active',
  notes TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS expenditures (
  id SERIAL PRIMARY KEY,
  expenditure_date DATE NOT NULL DEFAULT CURRENT_DATE,
  category TEXT NOT NULL DEFAULT 'General',
  description TEXT NOT NULL,
  amount NUMERIC(12,2) NOT NULL DEFAULT 0,
  payment_method TEXT NOT NULL DEFAULT 'Cash',
  reference TEXT,
  created_by INT REFERENCES users(id) ON DELETE SET NULL,
  expenditure_request_id INT,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS system_settings (
  setting_key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS fee_settings (
  setting_key TEXT PRIMARY KEY,
  value TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS school_calendar (
  id SERIAL PRIMARY KEY,
  title TEXT NOT NULL,
  event_date DATE NOT NULL,
  start_time TIME,
  end_time TIME,
  category TEXT NOT NULL DEFAULT 'School Activity',
  location TEXT,
  description TEXT,
  created_by INT REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id SERIAL PRIMARY KEY,
  user_id INT REFERENCES users(id),
  action TEXT NOT NULL,
  details TEXT,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS teacher_assignments (
  id SERIAL PRIMARY KEY,
  teacher_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  subject_id INT REFERENCES subjects(id) ON DELETE CASCADE,
  class_name TEXT NOT NULL,
  assignment_type TEXT NOT NULL DEFAULT 'subject' CHECK (assignment_type IN ('subject','class_teacher')),
  created_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(teacher_id,subject_id,class_name,assignment_type)
);

CREATE TABLE IF NOT EXISTS communications (
  id SERIAL PRIMARY KEY,
  title TEXT NOT NULL DEFAULT 'School Communication',
  message TEXT NOT NULL,
  audience_type TEXT NOT NULL DEFAULT 'all',
  audience_value TEXT,
  created_by INT REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS boarding_profiles (
  id SERIAL PRIMARY KEY,
  student_id INT NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  boarding_status TEXT NOT NULL DEFAULT 'active' CHECK(boarding_status IN ('active','inactive')),
  house TEXT, hostel TEXT, room TEXT, bed_no TEXT, admitted_on DATE, notes TEXT,
  created_by INT REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMP DEFAULT NOW(), updated_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(student_id)
);

CREATE TABLE IF NOT EXISTS boarding_attendance (
  id SERIAL PRIMARY KEY,
  student_id INT NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  attendance_date DATE NOT NULL,
  status TEXT NOT NULL DEFAULT 'present' CHECK(status IN ('present','absent','late','excused')),
  check_in TIME, check_out TIME, notes TEXT,
  marked_by INT REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMP DEFAULT NOW(), updated_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(student_id,attendance_date)
);

CREATE TABLE IF NOT EXISTS boarding_incidents (
  id SERIAL PRIMARY KEY,
  student_id INT NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  incident_date DATE NOT NULL DEFAULT CURRENT_DATE,
  category TEXT NOT NULL DEFAULT 'General',
  description TEXT NOT NULL,
  action_taken TEXT, follow_up TEXT,
  status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','resolved','follow_up')),
  created_by INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMP DEFAULT NOW(), updated_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS whatsapp_pending_notifications (
  id SERIAL PRIMARY KEY,
  event_key TEXT UNIQUE NOT NULL,
  event_type TEXT NOT NULL,
  student_id INT REFERENCES students(id) ON DELETE CASCADE,
  recipient_name TEXT, recipient_phone TEXT, message TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','sent','dismissed')),
  source_id TEXT, created_at TIMESTAMP DEFAULT NOW(), sent_at TIMESTAMP
);

CREATE TABLE IF NOT EXISTS whatsapp_communication_settings (
  event_type TEXT PRIMARY KEY,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  mode TEXT NOT NULL DEFAULT 'approval' CHECK(mode IN ('approval','automatic')),
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS approval_notifications (
  id SERIAL PRIMARY KEY,
  recipient_user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  notification_type TEXT NOT NULL,
  message TEXT NOT NULL,
  source_id TEXT,
  action_url TEXT,
  read_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(recipient_user_id,notification_type,source_id)
);

CREATE TABLE IF NOT EXISTS whatsapp_delivery_log (
  id SERIAL PRIMARY KEY,
  recipient_name TEXT, recipient_phone TEXT, event_type TEXT, message TEXT,
  status TEXT, provider_message_id TEXT, error TEXT,
  created_by INT REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS online_meetings (
  id SERIAL PRIMARY KEY,
  title TEXT NOT NULL, description TEXT,
  meeting_kind TEXT NOT NULL DEFAULT 'class' CHECK(meeting_kind IN ('class','meeting')),
  host_user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  subject_id INT REFERENCES subjects(id) ON DELETE SET NULL,
  class_name TEXT, scheduled_start TIMESTAMP NOT NULL, scheduled_end TIMESTAMP,
  actual_start TIMESTAMP, actual_end TIMESTAMP,
  status TEXT NOT NULL DEFAULT 'scheduled' CHECK(status IN ('scheduled','live','completed','cancelled')),
  room_code TEXT NOT NULL UNIQUE, provider TEXT NOT NULL DEFAULT 'jitsi',
  recording_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  chat_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  waiting_room_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMP DEFAULT NOW(), updated_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS online_participants (
  id SERIAL PRIMARY KEY,
  meeting_id INT NOT NULL REFERENCES online_meetings(id) ON DELETE CASCADE,
  user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'participant',
  invitation_status TEXT NOT NULL DEFAULT 'invited' CHECK(invitation_status IN ('invited','accepted','declined')),
  joined_at TIMESTAMP, left_at TIMESTAMP, created_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(meeting_id,user_id)
);

CREATE TABLE IF NOT EXISTS online_sessions (
  id SERIAL PRIMARY KEY,
  meeting_id INT NOT NULL REFERENCES online_meetings(id) ON DELETE CASCADE,
  user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  joined_at TIMESTAMP NOT NULL DEFAULT NOW(), left_at TIMESTAMP,
  connection_status TEXT NOT NULL DEFAULT 'connected'
);

CREATE TABLE IF NOT EXISTS online_chat (
  id SERIAL PRIMARY KEY,
  meeting_id INT NOT NULL REFERENCES online_meetings(id) ON DELETE CASCADE,
  sender_user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  message TEXT NOT NULL, created_at TIMESTAMP DEFAULT NOW(), deleted_at TIMESTAMP
);

CREATE TABLE IF NOT EXISTS online_attendance (
  id SERIAL PRIMARY KEY,
  meeting_id INT NOT NULL REFERENCES online_meetings(id) ON DELETE CASCADE,
  student_id INT NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'absent' CHECK(status IN ('present','late','partial','absent')),
  first_joined_at TIMESTAMP, last_left_at TIMESTAMP,
  total_duration_seconds INT NOT NULL DEFAULT 0,
  marked_by INT REFERENCES users(id) ON DELETE SET NULL,
  marked_at TIMESTAMP, notes TEXT,
  UNIQUE(meeting_id,student_id)
);

CREATE TABLE IF NOT EXISTS online_recordings (
  id SERIAL PRIMARY KEY,
  meeting_id INT NOT NULL REFERENCES online_meetings(id) ON DELETE CASCADE,
  recording_url TEXT NOT NULL,
  provider TEXT NOT NULL DEFAULT 'jitsi',
  duration_seconds INT,
  created_by INT REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS local_subscription_status (
  id INT PRIMARY KEY DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'unconfigured',
  plan TEXT, valid_until TIMESTAMP, grace_until TIMESTAMP,
  features JSONB NOT NULL DEFAULT '{}'::jsonb,
  last_sync TIMESTAMP, updated_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS payroll_profiles (
  staff_id INT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  basic_salary NUMERIC(12,2) NOT NULL DEFAULT 0,
  house_allowance NUMERIC(12,2) NOT NULL DEFAULT 0,
  transport_allowance NUMERIC(12,2) NOT NULL DEFAULT 0,
  other_allowance NUMERIC(12,2) NOT NULL DEFAULT 0,
  tax_deduction NUMERIC(12,2) NOT NULL DEFAULT 0,
  pension_deduction NUMERIC(12,2) NOT NULL DEFAULT 0,
  other_deduction NUMERIC(12,2) NOT NULL DEFAULT 0,
  bank_name TEXT, account_number TEXT, updated_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS payroll_periods (
  id SERIAL PRIMARY KEY,
  payroll_year INT NOT NULL, payroll_month INT NOT NULL CHECK(payroll_month BETWEEN 1 AND 12),
  status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','submitted','approved','rejected','paid','cancelled')),
  processed_by INT REFERENCES users(id), approved_by INT REFERENCES users(id),
  approved_at TIMESTAMP, paid_at TIMESTAMP, created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(), director_note TEXT,
  UNIQUE(payroll_year,payroll_month)
);

CREATE TABLE IF NOT EXISTS payroll_entries (
  id SERIAL PRIMARY KEY,
  period_id INT NOT NULL REFERENCES payroll_periods(id) ON DELETE CASCADE,
  staff_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  basic_salary NUMERIC(12,2) NOT NULL DEFAULT 0,
  house_allowance NUMERIC(12,2) NOT NULL DEFAULT 0,
  transport_allowance NUMERIC(12,2) NOT NULL DEFAULT 0,
  other_allowance NUMERIC(12,2) NOT NULL DEFAULT 0,
  tax_deduction NUMERIC(12,2) NOT NULL DEFAULT 0,
  pension_deduction NUMERIC(12,2) NOT NULL DEFAULT 0,
  other_deduction NUMERIC(12,2) NOT NULL DEFAULT 0,
  gross_pay NUMERIC(12,2) NOT NULL DEFAULT 0,
  total_deductions NUMERIC(12,2) NOT NULL DEFAULT 0,
  net_pay NUMERIC(12,2) NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','approved','paid')),
  notes TEXT, created_at TIMESTAMP DEFAULT NOW(), updated_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(period_id,staff_id)
);

CREATE TABLE IF NOT EXISTS expenditure_requests (
  id SERIAL PRIMARY KEY,
  category TEXT NOT NULL DEFAULT 'General', description TEXT NOT NULL,
  amount NUMERIC(12,2) NOT NULL, payment_method TEXT NOT NULL DEFAULT 'Cash',
  requested_date DATE DEFAULT CURRENT_DATE,
  requested_by INT NOT NULL REFERENCES users(id),
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected','paid')),
  reviewed_by INT REFERENCES users(id), reviewed_at TIMESTAMP, review_note TEXT,
  paid_at TIMESTAMP, payment_reference TEXT, created_at TIMESTAMP DEFAULT NOW(), updated_at TIMESTAMP DEFAULT NOW()
);

ALTER TABLE expenditures ADD COLUMN IF NOT EXISTS expenditure_request_id INT REFERENCES expenditure_requests(id) ON DELETE SET NULL;

CREATE TABLE IF NOT EXISTS exam_bank (
  id SERIAL PRIMARY KEY,
  subject_id INT NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
  class_name TEXT NOT NULL, term TEXT, topic TEXT,
  question_type TEXT NOT NULL DEFAULT 'Short Answer', question_text TEXT NOT NULL,
  option_a TEXT, option_b TEXT, option_c TEXT, option_d TEXT, answer TEXT,
  marks NUMERIC DEFAULT 1, created_by INT REFERENCES users(id),
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected')),
  reviewed_by INT REFERENCES users(id), reviewed_at TIMESTAMP, review_note TEXT,
  created_at TIMESTAMP DEFAULT NOW(), updated_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS exam_resources (
  id SERIAL PRIMARY KEY,
  title TEXT NOT NULL, description TEXT,
  subject_id INT NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
  class_name TEXT NOT NULL, term TEXT, academic_year INT,
  original_filename TEXT NOT NULL, mime_type TEXT NOT NULL, file_data BYTEA NOT NULL, file_size INT NOT NULL,
  uploaded_by INT NOT NULL REFERENCES users(id),
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected')),
  reviewed_by INT REFERENCES users(id), reviewed_at TIMESTAMP, review_note TEXT,
  price NUMERIC(10,2) NOT NULL DEFAULT 100,
  created_at TIMESTAMP DEFAULT NOW(), updated_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS resource_purchases (
  id SERIAL PRIMARY KEY,
  resource_id INT NOT NULL REFERENCES exam_resources(id) ON DELETE CASCADE,
  student_id INT NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  amount NUMERIC(10,2) NOT NULL DEFAULT 100,
  payment_method TEXT, reference TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','paid','rejected')),
  reviewed_by INT REFERENCES users(id), reviewed_at TIMESTAMP, review_note TEXT,
  paid_at TIMESTAMP, created_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(resource_id,student_id)
);

CREATE TABLE IF NOT EXISTS leave_requests (
  id SERIAL PRIMARY KEY,
  user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  leave_type TEXT NOT NULL DEFAULT 'Annual Leave', start_date DATE NOT NULL, end_date DATE NOT NULL,
  reason TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected')),
  approved_by INT REFERENCES users(id), approved_at TIMESTAMP, director_note TEXT,
  created_at TIMESTAMP DEFAULT NOW(), updated_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS staff_attendance (
  id SERIAL PRIMARY KEY,
  staff_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  attendance_date DATE NOT NULL, check_in TIMESTAMP, check_out TIMESTAMP,
  updated_at TIMESTAMP DEFAULT NOW(), UNIQUE(staff_id,attendance_date)
);

CREATE TABLE IF NOT EXISTS syllabus_coverage_reports (
  id SERIAL PRIMARY KEY,
  subject_id INT NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
  class_name TEXT NOT NULL, term TEXT NOT NULL, academic_year INT NOT NULL,
  coverage_percent NUMERIC(5,2) NOT NULL DEFAULT 0 CHECK(coverage_percent>=0 AND coverage_percent<=100),
  topics_covered TEXT, topics_pending TEXT, challenges TEXT, plans TEXT, resources_needed TEXT,
  target_completion_date DATE, teacher_comment TEXT,
  created_by INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected')),
  reviewed_by INT REFERENCES users(id), reviewed_at TIMESTAMP, review_note TEXT,
  created_at TIMESTAMP DEFAULT NOW(), updated_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(created_by,subject_id,class_name,term,academic_year)
);

CREATE TABLE IF NOT EXISTS student_subject_reports (
  id SERIAL PRIMARY KEY,
  student_id INT NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  subject_id INT NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
  class_name TEXT NOT NULL, term TEXT NOT NULL, academic_year INT NOT NULL,
  strengths TEXT, weaknesses TEXT, recommended_intervention TEXT, general_comment TEXT,
  created_by INT NOT NULL REFERENCES users(id),
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected')),
  reviewed_by INT REFERENCES users(id), reviewed_at TIMESTAMP, review_note TEXT,
  created_at TIMESTAMP DEFAULT NOW(), updated_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS student_subject_report_strands (
  id SERIAL PRIMARY KEY,
  report_id INT NOT NULL REFERENCES student_subject_reports(id) ON DELETE CASCADE,
  strand TEXT NOT NULL,
  rating TEXT NOT NULL DEFAULT 'developing' CHECK(rating IN ('strength','developing','needs_support')),
  observation TEXT
);

CREATE TABLE IF NOT EXISTS tafhid_groups (
  id SERIAL PRIMARY KEY,
  group_name TEXT NOT NULL,
  teacher_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  class_name TEXT, active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMP DEFAULT NOW(), UNIQUE(group_name,teacher_id)
);

CREATE TABLE IF NOT EXISTS tafhid_group_learners (
  id SERIAL PRIMARY KEY,
  group_id INT NOT NULL REFERENCES tafhid_groups(id) ON DELETE CASCADE,
  student_id INT NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  created_at TIMESTAMP DEFAULT NOW(), UNIQUE(group_id,student_id)
);

CREATE TABLE IF NOT EXISTS tafhid_assessments (
  id SERIAL PRIMARY KEY,
  group_id INT NOT NULL REFERENCES tafhid_groups(id) ON DELETE CASCADE,
  student_id INT NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  assessment_type TEXT NOT NULL CHECK(assessment_type IN ('monthly','end_term')),
  period_label TEXT NOT NULL, academic_year INT NOT NULL, juzu TEXT,
  q1 NUMERIC(6,2) DEFAULT 0, q2 NUMERIC(6,2) DEFAULT 0, q3 NUMERIC(6,2) DEFAULT 0,
  q4 NUMERIC(6,2) DEFAULT 0, q5 NUMERIC(6,2) DEFAULT 0, tajweed NUMERIC(6,2) DEFAULT 0,
  total NUMERIC(8,2) DEFAULT 0, teacher_comment TEXT,
  entered_by INT NOT NULL REFERENCES users(id), created_at TIMESTAMP DEFAULT NOW(), updated_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(group_id,student_id,assessment_type,period_label,academic_year)
);

-- Useful indexes for cards, dashboards and report queries.
CREATE INDEX IF NOT EXISTS idx_students_class ON students(class_name);
CREATE INDEX IF NOT EXISTS idx_students_user ON students(user_id);
CREATE INDEX IF NOT EXISTS idx_marks_exam_student ON marks(exam_id,student_id);
CREATE INDEX IF NOT EXISTS idx_marks_subject_exam ON marks(subject_id,exam_id);
CREATE INDEX IF NOT EXISTS idx_fee_records_student ON fee_records(student_id,created_at);
CREATE INDEX IF NOT EXISTS idx_fee_charges_student ON fee_charges(student_id,academic_year,term);
CREATE INDEX IF NOT EXISTS idx_expenditures_date ON expenditures(expenditure_date);
CREATE INDEX IF NOT EXISTS idx_school_calendar_date ON school_calendar(event_date);
CREATE INDEX IF NOT EXISTS idx_audit_logs_created ON audit_logs(created_at);
CREATE INDEX IF NOT EXISTS idx_teacher_assignments_teacher ON teacher_assignments(teacher_id,class_name);
CREATE INDEX IF NOT EXISTS idx_online_meetings_start ON online_meetings(scheduled_start,status);
CREATE INDEX IF NOT EXISTS idx_online_meetings_host ON online_meetings(host_user_id,scheduled_start);
CREATE INDEX IF NOT EXISTS idx_online_participants_user ON online_participants(user_id,meeting_id);
CREATE INDEX IF NOT EXISTS idx_online_sessions_meeting ON online_sessions(meeting_id,joined_at);
CREATE INDEX IF NOT EXISTS idx_online_chat_meeting ON online_chat(meeting_id,created_at);
CREATE INDEX IF NOT EXISTS idx_online_attendance_meeting ON online_attendance(meeting_id);
CREATE INDEX IF NOT EXISTS idx_online_recordings_meeting ON online_recordings(meeting_id);
CREATE INDEX IF NOT EXISTS idx_exam_resources_scope ON exam_resources(subject_id,class_name,status);
CREATE INDEX IF NOT EXISTS idx_resource_purchases_status ON resource_purchases(status);
CREATE INDEX IF NOT EXISTS idx_leave_requests_status ON leave_requests(status);
CREATE INDEX IF NOT EXISTS idx_staff_attendance_date ON staff_attendance(attendance_date);
CREATE INDEX IF NOT EXISTS idx_expenditure_requests_status ON expenditure_requests(status);
CREATE INDEX IF NOT EXISTS idx_syllabus_coverage_reports_scope ON syllabus_coverage_reports(subject_id,class_name,academic_year,term);
CREATE INDEX IF NOT EXISTS idx_syllabus_coverage_reports_status ON syllabus_coverage_reports(status);
CREATE INDEX IF NOT EXISTS idx_student_subject_reports_student ON student_subject_reports(student_id,academic_year,term);
CREATE INDEX IF NOT EXISTS idx_tafhid_groups_teacher ON tafhid_groups(teacher_id);
CREATE INDEX IF NOT EXISTS idx_tafhid_members_group ON tafhid_group_learners(group_id);
CREATE INDEX IF NOT EXISTS idx_tafhid_assessments_student ON tafhid_assessments(student_id,academic_year,assessment_type);
CREATE INDEX IF NOT EXISTS idx_tafhid_assessments_group ON tafhid_assessments(group_id,academic_year,assessment_type);
CREATE INDEX IF NOT EXISTS idx_boarding_profiles_status ON boarding_profiles(boarding_status);
CREATE INDEX IF NOT EXISTS idx_boarding_profiles_house ON boarding_profiles(house,hostel,room);
CREATE INDEX IF NOT EXISTS idx_boarding_attendance_date ON boarding_attendance(attendance_date,status);
CREATE INDEX IF NOT EXISTS idx_boarding_incidents_date ON boarding_incidents(incident_date,status);
CREATE INDEX IF NOT EXISTS idx_approval_notifications_recipient ON approval_notifications(recipient_user_id,read_at,created_at DESC);
CREATE INDEX IF NOT EXISTS idx_local_subscription_valid_until ON local_subscription_status(valid_until);
CREATE INDEX IF NOT EXISTS idx_payroll_entries_period ON payroll_entries(period_id);

INSERT INTO system_settings(setting_key,value) VALUES('operation_mode','demo') ON CONFLICT(setting_key) DO NOTHING;

INSERT INTO whatsapp_communication_settings(event_type,enabled,mode) VALUES
('fees',TRUE,'automatic'),('results',TRUE,'automatic'),('tafhid',TRUE,'automatic'),
('announcement',TRUE,'automatic'),('exam-resource',TRUE,'automatic'),('payroll',TRUE,'automatic'),
('expenditure',TRUE,'automatic'),('leave',TRUE,'automatic'),('resource-payment',TRUE,'automatic'),
('student-subject-report',TRUE,'automatic')
ON CONFLICT(event_type) DO NOTHING;

COMMIT;
