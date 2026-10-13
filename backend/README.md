# HireLens AI — Backend

FastAPI backend for a resume review and interview-preparation demo.

## Requirements
- Python 3.10+
- A Groq API key for AI analysis and question generation

## Windows PowerShell setup

From the `backend` directory:

```powershell
py -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install -r requirements.txt
Copy-Item .env.example .env
```

Open `.env` and replace `your_groq_api_key_here` with your own key. Never share it or commit `.env`.

Start the API:

```powershell
python -m uvicorn main:app --reload
```

Open http://127.0.0.1:8000/docs

## Endpoints
- `GET /` and `GET /health`
- `POST /upload-resume` — one PDF per request
- `GET /candidates`
- `GET /candidates/{candidate_id}`
- `PATCH /candidates/{candidate_id}` — rename candidate
- `DELETE /candidates/{candidate_id}`
- `DELETE /candidates?confirm=true` — delete all records
- `POST /analyze` — analyze saved resumes against a job description
- `POST /generate-questions` — generate interview questions
- `GET /stats`

## Notes
- The app stores extracted resume text and candidate details in local SQLite. Uploaded PDFs are not persisted.
- Scanned-image PDFs without selectable text are not supported by this version.
- AI outputs are decision support only. Human reviewers must verify findings and make all hiring decisions.
- Before deploying, set `FRONTEND_ORIGINS` to your exact deployed frontend origin and use a persistent disk/database strategy for production.
