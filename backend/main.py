
import os
import re
import json
import sqlite3
import uuid
from datetime import datetime, timezone
from pathlib import Path

import fitz
from dotenv import load_dotenv
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from groq import Groq
from pydantic import BaseModel, Field

BASE_DIR = Path(__file__).resolve().parent
UPLOAD_DIR = BASE_DIR / "uploads"
DATABASE_PATH = BASE_DIR / "hirelens.db"
MAX_FILE_SIZE = 10 * 1024 * 1024
MAX_RESUME_TEXT_CHARS = 30000

UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
load_dotenv(BASE_DIR / ".env")

app = FastAPI(
    title="HireLens AI API",
    description="AI-assisted resume review and interview preparation.",
    version="1.1.0",
)

origins = os.getenv(
    "FRONTEND_ORIGINS",
    "http://localhost:5173,http://127.0.0.1:5173",
)
app.add_middleware(
    CORSMiddleware,
    allow_origins=[x.strip() for x in origins.split(",") if x.strip()],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)


def db_connection():
    conn = sqlite3.connect(DATABASE_PATH, timeout=15)
    conn.row_factory = sqlite3.Row
    return conn


def init_db():
    with db_connection() as conn:
        conn.execute("""
            CREATE TABLE IF NOT EXISTS candidates (
                id TEXT PRIMARY KEY,
                filename TEXT NOT NULL,
                name TEXT NOT NULL,
                email TEXT NOT NULL DEFAULT '',
                resume_text TEXT NOT NULL,
                job_description TEXT NOT NULL DEFAULT '',
                analysis TEXT NOT NULL DEFAULT '',
                created_at TEXT NOT NULL
            )
        """)

        # Add new columns without deleting existing candidates.
        existing = {
            row["name"]
            for row in conn.execute("PRAGMA table_info(candidates)").fetchall()
        }

        migrations = {
            "shortlist_status":
                "ALTER TABLE candidates ADD COLUMN shortlist_status TEXT NOT NULL DEFAULT 'Under Review'",
            "rank_score":
                "ALTER TABLE candidates ADD COLUMN rank_score REAL",
            "rank_details":
                "ALTER TABLE candidates ADD COLUMN rank_details TEXT NOT NULL DEFAULT '{}'",
            "ranked_job_description":
                "ALTER TABLE candidates ADD COLUMN ranked_job_description TEXT NOT NULL DEFAULT ''",
        }

        for column, sql in migrations.items():
            if column not in existing:
                conn.execute(sql)

        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_candidates_created "
            "ON candidates(created_at)"
        )


init_db()


class AnalyzeRequest(BaseModel):
    job_description: str = Field(min_length=20, max_length=12000)


class RankRequest(BaseModel):
    job_description: str = Field(min_length=20, max_length=12000)


class ShortlistStatusRequest(BaseModel):
    status: str


class GenerateQuestionsRequest(BaseModel):
    job_description: str = Field(min_length=20, max_length=12000)
    candidate_summary: str = Field(default="", max_length=12000)


class UpdateCandidateRequest(BaseModel):
    name: str = Field(min_length=1, max_length=150)


def get_groq_client():
    api_key = os.getenv("GROQ_API_KEY", "").strip()

    if not api_key or api_key == "your_groq_api_key_here":
        raise HTTPException(
            status_code=503,
            detail="AI is not configured. Check GROQ_API_KEY in backend/.env.",
        )

    return Groq(api_key=api_key)


def ai_completion(system_prompt: str, user_prompt: str) -> str:
    client = get_groq_client()
    model = os.getenv(
        "GROQ_MODEL",
        "llama-3.3-70b-versatile",
    ).strip()

    try:
        response = client.chat.completions.create(
            model=model,
            messages=[
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_prompt},
            ],
            temperature=0.2,
        )

        content = response.choices[0].message.content

        if not content:
            raise HTTPException(
                status_code=502,
                detail="The AI provider returned an empty response.",
            )

        return content.strip()

    except HTTPException:
        raise
    except Exception as exc:
        print(f"Groq request failed: {type(exc).__name__}: {exc}")
        raise HTTPException(
            status_code=502,
            detail=(
                "AI request failed. Check the API key, model name, "
                "network connection, and provider usage limits."
            ),
        ) from exc


def extract_pdf_text(pdf_bytes: bytes) -> str:
    try:
        with fitz.open(stream=pdf_bytes, filetype="pdf") as document:
            text = "\n".join(page.get_text("text") for page in document)
    except Exception as exc:
        raise HTTPException(
            status_code=400,
            detail="This file could not be read as a valid PDF.",
        ) from exc

    text = text.strip()

    if not text:
        raise HTTPException(
            status_code=400,
            detail=(
                "No selectable text was found. Scanned-image resumes "
                "are not supported by this version."
            ),
        )

    return text[:MAX_RESUME_TEXT_CHARS]


def parse_contact_details(text: str):
    email_match = re.search(
        r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}",
        text,
    )

    lines = [line.strip() for line in text.splitlines() if line.strip()]
    name = lines[0][:150] if lines else "Unknown candidate"

    if "@" in name or re.search(
        r"\b(resume|curriculum vitae|cv)\b", name, re.I
    ):
        name = "Unknown candidate"

    return name, email_match.group(0) if email_match else ""


def row_to_candidate(row, include_resume_text=False):
    result = {
        "id": row["id"],
        "filename": row["filename"],
        "name": row["name"],
        "email": row["email"],
        "job_description": row["job_description"],
        "analysis": row["analysis"],
        "created_at": row["created_at"],
        "analyzed": bool(row["analysis"]),
        "shortlist_status": row["shortlist_status"],
        "rank_score": row["rank_score"],
        "rank_details": json.loads(row["rank_details"] or "{}"),
        "ranked_job_description": row["ranked_job_description"],
    }

    if include_resume_text:
        result["resume_text"] = row["resume_text"]

    return result


def parse_rank_details(raw: str):
    """Parse and validate the structured ranking response from the AI."""
    cleaned = raw.strip()

    # Handle models that wrap JSON in Markdown fences.
    cleaned = re.sub(r"^```(?:json)?\s*", "", cleaned, flags=re.I)
    cleaned = re.sub(r"\s*```$", "", cleaned)

    try:
        data = json.loads(cleaned)
    except json.JSONDecodeError:
        match = re.search(r"\{.*\}", cleaned, flags=re.S)
        if not match:
            raise HTTPException(
                status_code=502,
                detail="The AI returned an invalid ranking response. Please try again.",
            )
        try:
            data = json.loads(match.group(0))
        except json.JSONDecodeError as exc:
            raise HTTPException(
                status_code=502,
                detail="The AI returned an invalid ranking response. Please try again.",
            ) from exc

    def percentage(value):
        try:
            return round(max(0, min(100, float(value))))
        except (TypeError, ValueError):
            return 0

    def string_list(value):
        if not isinstance(value, list):
            return []
        return [str(item)[:500] for item in value[:8]]

    return {
        "skills_match": percentage(data.get("skills_match")),
        "experience_match": percentage(data.get("experience_match")),
        "requirements_evidence": percentage(data.get("requirements_evidence")),
        "overall_alignment": percentage(data.get("overall_alignment")),
        "rationale": str(data.get("rationale", ""))[:2000],
        "strengths": string_list(data.get("strengths")),
        "gaps_or_unclear": string_list(data.get("gaps_or_unclear")),
    }


def calculate_candidate_ranking(job_description: str, resume_text: str):
    system_prompt = """
You are HireLens AI, a recruitment decision-support assistant.

Compare the supplied resume with the job description using only job-related
evidence. Do not use age, gender, race, religion, disability, family status,
or other protected or irrelevant personal characteristics.

Return ONLY one valid JSON object with exactly these keys:
{
  "skills_match": 0,
  "experience_match": 0,
  "requirements_evidence": 0,
  "overall_alignment": 0,
  "rationale": "Brief explanation grounded in the resume",
  "strengths": ["Evidence-supported strength"],
  "gaps_or_unclear": ["Requirement not evidenced or unclear"]
}

The four numeric fields must be whole-number estimates from 0 to 100.
Base them on skills, relevant experience, evidence for requirements, and
overall job-related alignment. Missing evidence should not automatically
be treated as proof that a person lacks the skill. Do not invent experience.
Do not make a hiring decision. Return JSON only, without Markdown fences.
"""

    raw = ai_completion(
        system_prompt,
        f"JOB DESCRIPTION:\n{job_description}\n\n"
        f"RESUME:\n{resume_text[:MAX_RESUME_TEXT_CHARS]}\n\n"
        "Assess this candidate independently against the job description.",
    )

    return parse_rank_details(raw)


@app.get("/")
def root():
    return {
        "name": "HireLens AI API",
        "status": "running",
        "version": app.version,
        "docs": "/docs",
        "health": "/health",
    }


@app.get("/health")
def health():
    key = os.getenv("GROQ_API_KEY", "").strip()
    return {
        "status": "healthy",
        "database": "ready",
        "ai_configured": bool(
            key and key != "your_groq_api_key_here"
        ),
    }


@app.post("/upload-resume")
async def upload_resume(file: UploadFile = File(...)):
    filename = Path(file.filename or "resume.pdf").name

    if not filename.lower().endswith(".pdf"):
        raise HTTPException(
            status_code=400,
            detail="Only PDF resumes are supported.",
        )

    pdf_bytes = await file.read()

    if not pdf_bytes:
        raise HTTPException(status_code=400, detail="The uploaded file is empty.")

    if len(pdf_bytes) > MAX_FILE_SIZE:
        raise HTTPException(
            status_code=413,
            detail="Resume exceeds the 10 MB file-size limit.",
        )

    resume_text = extract_pdf_text(pdf_bytes)
    name, email = parse_contact_details(resume_text)
    candidate_id = str(uuid.uuid4())
    created_at = datetime.now(timezone.utc).isoformat(timespec="seconds")

    with db_connection() as conn:
        conn.execute(
            """
            INSERT INTO candidates
            (id, filename, name, email, resume_text,
             job_description, analysis, created_at)
            VALUES (?, ?, ?, ?, ?, '', '', ?)
            """,
            (
                candidate_id,
                filename,
                name,
                email,
                resume_text,
                created_at,
            ),
        )

    return {
        "id": candidate_id,
        "filename": filename,
        "name": name,
        "email": email,
        "characters_extracted": len(resume_text),
        "message": "Resume uploaded and text extracted successfully.",
    }


@app.get("/candidates")
def list_candidates():
    with db_connection() as conn:
        rows = conn.execute(
            "SELECT * FROM candidates ORDER BY created_at DESC"
        ).fetchall()

    return {"candidates": [row_to_candidate(row) for row in rows]}


@app.get("/candidates/{candidate_id}")
def get_candidate(candidate_id: str):
    with db_connection() as conn:
        row = conn.execute(
            "SELECT * FROM candidates WHERE id = ?",
            (candidate_id,),
        ).fetchone()

    if row is None:
        raise HTTPException(status_code=404, detail="Candidate not found.")

    return row_to_candidate(row, include_resume_text=True)


@app.patch("/candidates/{candidate_id}")
def rename_candidate(candidate_id: str, request: UpdateCandidateRequest):
    with db_connection() as conn:
        result = conn.execute(
            "UPDATE candidates SET name = ? WHERE id = ?",
            (request.name.strip(), candidate_id),
        )

    if result.rowcount == 0:
        raise HTTPException(status_code=404, detail="Candidate not found.")

    return {"message": "Candidate name updated."}


@app.patch("/candidates/{candidate_id}/shortlist-status")
def update_shortlist_status(
    candidate_id: str,
    request: ShortlistStatusRequest,
):
    allowed_statuses = {
        "Under Review",
        "Shortlisted",
        "Not Selected",
    }

    if request.status not in allowed_statuses:
        raise HTTPException(
            status_code=400,
            detail="Invalid status. Use Under Review, Shortlisted, or Not Selected.",
        )

    with db_connection() as conn:
        result = conn.execute(
            "UPDATE candidates SET shortlist_status = ? WHERE id = ?",
            (request.status, candidate_id),
        )

    if result.rowcount == 0:
        raise HTTPException(status_code=404, detail="Candidate not found.")

    return {
        "id": candidate_id,
        "shortlist_status": request.status,
        "message": "Shortlist status saved.",
    }


@app.delete("/candidates/{candidate_id}")
def delete_candidate(candidate_id: str):
    with db_connection() as conn:
        result = conn.execute(
            "DELETE FROM candidates WHERE id = ?",
            (candidate_id,),
        )

    if result.rowcount == 0:
        raise HTTPException(status_code=404, detail="Candidate not found.")

    return {"message": "Candidate deleted successfully.", "id": candidate_id}


@app.post("/analyze")
def analyze_candidates(request: AnalyzeRequest):
    job_description = request.job_description.strip()

    with db_connection() as conn:
        rows = conn.execute(
            "SELECT * FROM candidates ORDER BY created_at DESC"
        ).fetchall()

    if not rows:
        raise HTTPException(
            status_code=400,
            detail="Upload at least one PDF resume before running analysis.",
        )

    system_prompt = (
        "You are HireLens AI, a careful recruitment decision-support assistant. "
        "Review only job-related evidence. Do not infer or use protected or "
        "irrelevant personal characteristics. Do not invent facts or make "
        "hire/reject decisions. Distinguish evidence found from information "
        "not stated. Use these headings exactly: Candidate Summary; Relevant "
        "Skills; Relevant Experience; Evidence Matching Job Requirements; "
        "Requirements Not Evidenced or Unclear; Suggested Interview Focus. "
        "Use concise bullet points. Do not create a numerical hiring score."
    )

    results = []

    for row in rows:
        analysis = ai_completion(
            system_prompt,
            f"JOB DESCRIPTION:\n{job_description}\n\n"
            f"RESUME:\n{row['resume_text']}\n\n"
            "Analyze this candidate for human review. Do not compare candidates.",
        )

        with db_connection() as conn:
            conn.execute(
                "UPDATE candidates SET job_description = ?, analysis = ? WHERE id = ?",
                (job_description, analysis, row["id"]),
            )

        results.append({
            "id": row["id"],
            "filename": row["filename"],
            "name": row["name"],
            "email": row["email"],
            "analysis": analysis,
        })

    return {
        "count": len(results),
        "job_description": job_description,
        "results": results,
        "notice": (
            "AI output may be incomplete or incorrect. Verify the original "
            "resume and review findings before making decisions."
        ),
    }


@app.post("/rank")
def rank_candidates(request: RankRequest):
    job_description = request.job_description.strip()

    with db_connection() as conn:
        rows = conn.execute(
            "SELECT * FROM candidates ORDER BY created_at DESC"
        ).fetchall()

    if not rows:
        raise HTTPException(
            status_code=400,
            detail="Upload at least one PDF resume before ranking candidates.",
        )

    results = []

    for row in rows:
        details = calculate_candidate_ranking(
            job_description,
            row["resume_text"],
        )

        # Transparent, fixed combination of the four evidence dimensions.
        score = round(
            details["skills_match"] * 0.35
            + details["experience_match"] * 0.20
            + details["requirements_evidence"] * 0.25
            + details["overall_alignment"] * 0.20
        )

        details_json = json.dumps(details, ensure_ascii=False)

        with db_connection() as conn:
            conn.execute(
                """
                UPDATE candidates
                SET rank_score = ?,
                    rank_details = ?,
                    ranked_job_description = ?
                WHERE id = ?
                """,
                (score, details_json, job_description, row["id"]),
            )

        results.append({
            "id": row["id"],
            "filename": row["filename"],
            "name": row["name"],
            "email": row["email"],
            "rank_score": score,
            "rank_details": details,
            "shortlist_status": row["shortlist_status"],
        })

    results.sort(key=lambda item: item["rank_score"], reverse=True)

    for position, item in enumerate(results, start=1):
        item["rank"] = position

    return {
        "count": len(results),
        "job_description": job_description,
        "results": results,
        "notice": (
            "Scores are AI-generated estimates for review, not objective "
            "measures of candidate quality. Verify the evidence in each resume."
        ),
    }


@app.post("/generate-questions")
def generate_questions(request: GenerateQuestionsRequest):
    questions = ai_completion(
        "You are an experienced interviewer. Create fair, role-related "
        "interview questions. Do not ask about protected or irrelevant "
        "personal characteristics. Do not assume facts that are not supplied. "
        "Return readable Markdown with sections Technical Questions, "
        "Problem-Solving Questions, and Experience Questions. For each "
        "question, explain what a strong answer should demonstrate.",
        f"JOB DESCRIPTION:\n{request.job_description.strip()}\n\n"
        f"CANDIDATE SUMMARY:\n"
        f"{request.candidate_summary.strip() or 'Not provided'}\n\n"
        "Generate 10 practical interview questions.",
    )

    return {"questions": questions}


@app.get("/stats")
def stats():
    with db_connection() as conn:
        total = conn.execute(
            "SELECT COUNT(*) FROM candidates"
        ).fetchone()[0]

        analyzed = conn.execute(
            "SELECT COUNT(*) FROM candidates WHERE analysis != ''"
        ).fetchone()[0]

        ranked = conn.execute(
            "SELECT COUNT(*) FROM candidates WHERE rank_score IS NOT NULL"
        ).fetchone()[0]

        shortlisted = conn.execute(
            "SELECT COUNT(*) FROM candidates WHERE shortlist_status = 'Shortlisted'"
        ).fetchone()[0]

    return {
        "total_candidates": total,
        "analyzed_candidates": analyzed,
        "pending_analysis": total - analyzed,
        "ranked_candidates": ranked,
        "shortlisted_candidates": shortlisted,
    }


@app.delete("/candidates")
def delete_all_candidates(confirm: bool = False):
    if not confirm:
        raise HTTPException(
            status_code=400,
            detail="Pass confirm=true to delete all candidate records. This cannot be undone.",
        )

    with db_connection() as conn:
        conn.execute("DELETE FROM candidates")

    return {"message": "All candidate records were deleted."}
