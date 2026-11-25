-- ============================================================================
-- SEED DATA AWAL PRA-REGISTRASI (IDEMPOTENT) - EXAM-SEMESTER
-- Mengisi contoh semester, mata kuliah, dan kelas (class_sections)
-- ============================================================================

BEGIN;

-- 1. Semester contoh (menandai 2026-2 sebagai semester aktif)
INSERT INTO public.semesters (code, name, is_active, start_date, end_date)
VALUES
    ('2026-1', 'Ganjil 2026/2027', FALSE, '2026-08-01', '2027-01-31'),
    ('2026-2', 'Genap 2026/2027', TRUE,  '2027-02-01', '2027-07-31')
ON CONFLICT (code) DO NOTHING;

-- 2. Mata kuliah contoh
INSERT INTO public.courses (course_code, course_name, credits, description)
VALUES
    ('IF2101', 'Pemrograman Web & Basis Data', 3, 'Pengembangan aplikasi web dan pengelolaan basis data relasional.'),
    ('IF2204', 'Rekayasa Perangkat Lunak', 3, 'Perancangan arsitektur, pengujian, dan pengelolaan sistem informasi.')
ON CONFLICT (course_code) DO NOTHING;

-- 3. Kelas (class_sections) terhubung ke mata kuliah & semester aktif (2026-2)
WITH active_sem AS (
    SELECT semester_id
    FROM public.semesters
    WHERE code = '2026-2'
    LIMIT 1
),
course_web AS (
    SELECT course_id
    FROM public.courses
    WHERE course_code = 'IF2101'
    LIMIT 1
),
course_rpl AS (
    SELECT course_id
    FROM public.courses
    WHERE course_code = 'IF2204'
    LIMIT 1
)
INSERT INTO public.class_sections (course_id, semester_id, class_code, class_type, weight_config)
SELECT course_web.course_id, active_sem.semester_id, 'TI-A', 'Reguler',
       '{"quiz": 20, "individual_task": 10, "group_task": 10, "uts": 20, "project": 15, "uas": 25}'::jsonb
FROM course_web, active_sem
UNION ALL
SELECT course_web.course_id, active_sem.semester_id, 'TI-B', 'Karyawan',
       '{"quiz": 20, "individual_task": 10, "group_task": 10, "uts": 20, "project": 15, "uas": 25}'::jsonb
FROM course_web, active_sem
UNION ALL
SELECT course_rpl.course_id, active_sem.semester_id, 'TI-A', 'Reguler',
       '{"quiz": 15, "individual_task": 15, "group_task": 10, "uts": 20, "project": 15, "uas": 25}'::jsonb
FROM course_rpl, active_sem
ON CONFLICT (course_id, semester_id, class_code) DO NOTHING;

COMMIT;

-- Verifikasi jumlah baris setelah seed (jalankan 2x untuk menguji idempotensi)
SELECT 'semesters' AS tabel, COUNT(*) AS total_baris FROM public.semesters
UNION ALL
SELECT 'courses', COUNT(*) FROM public.courses
UNION ALL
SELECT 'class_sections', COUNT(*) FROM public.class_sections;