-- ============================================================================
-- TAHAP 4: AUTENTIKASI & PEMISAHAN HAK AKSES (IDEMPOTENT) - EXAM-SEMESTER
-- ============================================================================

BEGIN;

-- Pastikan kolom email & role pada users konsisten dan aman
CREATE INDEX IF NOT EXISTS idx_users_auth_uid ON public.users(auth_uid);
CREATE INDEX IF NOT EXISTS idx_users_role ON public.users(role);
CREATE INDEX IF NOT EXISTS idx_students_user_id ON public.students(user_id);
CREATE INDEX IF NOT EXISTS idx_class_sections_lecturer ON public.class_sections(lecturer_id);

-- Fungsi sinkronisasi saat user baru mendaftar di auth.users
CREATE OR REPLACE FUNCTION public.handle_new_auth_user()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_role TEXT;
    v_name TEXT;
    v_nim TEXT;
    v_user_id UUID;
BEGIN
    v_role := COALESCE(NEW.raw_user_meta_data->>'role', 'student');
    IF v_role NOT IN ('admin', 'lecturer', 'student') THEN
        v_role := 'student';
    END IF;

    v_name := COALESCE(
        NULLIF(TRIM(NEW.raw_user_meta_data->>'full_name'), ''),
        split_part(NEW.email, '@', 1)
    );

    INSERT INTO public.users (auth_uid, email, full_name, role, is_active)
    VALUES (NEW.id, NEW.email, v_name, v_role, TRUE)
    ON CONFLICT (email)
    DO UPDATE SET
        auth_uid = COALESCE(public.users.auth_uid, EXCLUDED.auth_uid),
        full_name = COALESCE(NULLIF(public.users.full_name, ''), EXCLUDED.full_name),
        updated_at = NOW()
    RETURNING user_id INTO v_user_id;

    -- Jika mahasiswa dan metadata menyertakan NIM, tautkan ke tabel students
    v_nim := NULLIF(TRIM(NEW.raw_user_meta_data->>'nim'), '');
    IF v_role = 'student' AND v_nim IS NOT NULL THEN
        INSERT INTO public.students (user_id, nim, full_name, email)
        VALUES (v_user_id, v_nim, v_name, NEW.email)
        ON CONFLICT (nim)
        DO UPDATE SET
            user_id = COALESCE(public.students.user_id, EXCLUDED.user_id),
            full_name = EXCLUDED.full_name,
            email = COALESCE(public.students.email, EXCLUDED.email),
            updated_at = NOW();
    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
    AFTER INSERT ON auth.users
    FOR EACH ROW
    EXECUTE FUNCTION public.handle_new_auth_user();

COMMIT;