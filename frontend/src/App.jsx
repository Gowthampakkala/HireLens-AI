import { useCallback, useEffect, useMemo, useState } from "react";
import "./App.css";

const API = "http://127.0.0.1:8000";
const EMPTY_JOB = "";

async function apiRequest(path, options = {}) {
  const response = await fetch(`${API}${path}`, options);
  const contentType = response.headers.get("content-type") || "";
  const data = contentType.includes("application/json") ? await response.json() : {};
  if (!response.ok) {
    const message = data.detail || `Request failed (${response.status})`;
    throw new Error(message);
  }
  return data;
}

function parseInterviewQuestions(input = "") {
  const lines = input.split("\n");
  const result = [];
  let section = "Interview Questions";
  let current = null;

  const flush = () => {
    if (current) result.push(current);
    current = null;
  };

  for (const original of lines) {
    const line = original.trim();
    if (!line) continue;

    if (/^#{1,4}\s+/.test(line)) {
      flush();
      section = line.replace(/^#{1,4}\s+/, "").replace(/\*\*/g, "");
      continue;
    }

    const questionMatch = line.match(/^(?:[-*]\s*)?(?:\*\*)?(?:Q(?:uestion)?\s*)?(\d{1,2})[.) :\-]+\s*(.*?)(?:\*\*)?$/i);
    if (questionMatch && questionMatch[2]) {
      flush();
      current = { number: questionMatch[1], question: questionMatch[2].replace(/\*\*/g, ""), section, guidance: [] };
      continue;
    }

    if (!current && (line.endsWith("?") || /^\d+[.)]\s+/.test(line))) {
      flush();
      current = { number: String(result.length + 1), question: line.replace(/^\d+[.)]\s+/, ""), section, guidance: [] };
      continue;
    }

    if (current) {
      current.guidance.push(line.replace(/^[-*]\s*/, "").replace(/\*\*/g, ""));
    } else {
      result.push({ number: "", question: "", section, guidance: [line.replace(/\*\*/g, "")] });
    }
  }
  flush();
  return result;
}

function initials(name = "") {
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]).join("").toUpperCase() || "C";
}

function statusClass(status = "Under Review") {
  if (status === "Shortlisted") return "status-green";
  if (status === "Not Selected") return "status-red";
  return "status-yellow";
}

export default function App() {
  const [activePage, setActivePage] = useState("Dashboard");
  const [stats, setStats] = useState({});
  const [candidates, setCandidates] = useState([]);
  const [jobDescription, setJobDescription] = useState("");
  const [questionJob, setQuestionJob] = useState("");
  const [questionSummary, setQuestionSummary] = useState("");
  const [questions, setQuestions] = useState("");
  const [analysisResults, setAnalysisResults] = useState([]);
  const [rankResults, setRankResults] = useState([]);
  const [rankJobDescription, setRankJobDescription] = useState("");
  const [selectedCandidate, setSelectedCandidate] = useState("");
  const [selectedFile, setSelectedFile] = useState(null);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("All");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const refreshData = useCallback(async () => {
    const [statsData, candidateData] = await Promise.all([
      apiRequest("/stats"),
      apiRequest("/candidates"),
    ]);
    setStats(statsData);
    setCandidates(candidateData.candidates || []);
  }, []);

  useEffect(() => {
    refreshData().catch((err) => setError(err.message));
  }, [refreshData]);

  useEffect(() => {
    if (!selectedCandidate && candidates.length) setSelectedCandidate(candidates[0].id);
  }, [candidates, selectedCandidate]);

  const filteredCandidates = useMemo(() => {
    const query = search.toLowerCase().trim();
    return candidates.filter((candidate) => {
      const matchesSearch = !query || `${candidate.name} ${candidate.email} ${candidate.filename}`.toLowerCase().includes(query);
      const matchesStatus = statusFilter === "All" || candidate.shortlist_status === statusFilter;
      return matchesSearch && matchesStatus;
    });
  }, [candidates, search, statusFilter]);

  const selectedCandidateRecord = candidates.find((candidate) => candidate.id === selectedCandidate);

  async function runBusy(key, action) {
    setBusy(key);
    setError("");
    setNotice("");
    try {
      await action();
    } catch (err) {
      setError(err.message || "Something went wrong.");
    } finally {
      setBusy("");
    }
  }

  function goTo(page) {
    setActivePage(page);
    setError("");
    setNotice("");
  }

  async function uploadResume(event) {
    event.preventDefault();
    if (!selectedFile) {
      setError("Choose a PDF resume first.");
      return;
    }
    await runBusy("upload", async () => {
      const form = new FormData();
      form.append("file", selectedFile);
      const result = await apiRequest("/upload-resume", { method: "POST", body: form });
      setNotice(`${result.name} uploaded successfully.`);
      setSelectedFile(null);
      event.target.reset();
      await refreshData();
      setActivePage("Candidates");
    });
  }

  async function analyzeAll(event) {
    event.preventDefault();
    await runBusy("analyze", async () => {
      const result = await apiRequest("/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ job_description: jobDescription }),
      });
      setAnalysisResults(result.results || []);
      setNotice(`AI analysis completed for ${result.count} candidate(s).`);
      await refreshData();
    });
  }

  async function rankAll(event) {
    event.preventDefault();
    await runBusy("rank", async () => {
      const result = await apiRequest("/rank", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ job_description: rankJobDescription }),
      });
      setRankResults(result.results || []);
      setNotice(`Ranking completed for ${result.count} candidate(s). Review the evidence before making decisions.`);
      await refreshData();
    });
  }

  async function updateStatus(candidateId, status) {
    await runBusy(`status-${candidateId}`, async () => {
      await apiRequest(`/candidates/${candidateId}/shortlist-status`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status }),
      });
      setCandidates((previous) => previous.map((item) => item.id === candidateId ? { ...item, shortlist_status: status } : item));
      setRankResults((previous) => previous.map((item) => item.id === candidateId ? { ...item, shortlist_status: status } : item));
      await refreshData();
      setNotice("Shortlist status saved.");
    });
  }

  async function deleteCandidate(candidate) {
    if (!window.confirm(`Delete ${candidate.name} and their saved analysis? This cannot be undone.`)) return;
    await runBusy(`delete-${candidate.id}`, async () => {
      await apiRequest(`/candidates/${candidate.id}`, { method: "DELETE" });
      setCandidates((previous) => previous.filter((item) => item.id !== candidate.id));
      setRankResults((previous) => previous.filter((item) => item.id !== candidate.id));
      setNotice("Candidate deleted.");
      await refreshData();
    });
  }

  async function generateQuestions(event) {
    event.preventDefault();
    await runBusy("questions", async () => {
      const result = await apiRequest("/generate-questions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ job_description: questionJob, candidate_summary: questionSummary }),
      });
      setQuestions(result.questions || "");
      setNotice("Interview questions generated.");
    });
  }

  const navItems = [
    { label: "Dashboard", icon: "▦" },
    { label: "Candidates", icon: "♙" },
    { label: "AI Screening", icon: "⌕" },
    { label: "Ranking & Shortlist", icon: "↗" },
    { label: "Interview Questions", icon: "☷" },
  ];

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">H</div>
          <div><strong>HireLens<span> AI</span></strong><small>RECRUITMENT WORKSPACE</small></div>
        </div>
        <div className="nav-label">WORKSPACE</div>
        <nav>
          {navItems.map((item) => (
            <button key={item.label} className={`nav-item ${activePage === item.label ? "active" : ""}`} onClick={() => goTo(item.label)}>
              <span className="nav-icon">{item.icon}</span><span>{item.label}</span>
              {item.label === "Ranking & Shortlist" && <span className="nav-new">NEW</span>}
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <div className="sidebar-status"><span className="online-dot" /> API workspace</div>
          <p>AI-assisted hiring.<br />Human-led decisions.</p>
        </div>
      </aside>

      <main className="main-area">
        <header className="topbar">
          <div>
            <div className="breadcrumb">Workspace <span>/</span> {activePage}</div>
            <h1>{activePage}</h1>
          </div>
          <div className="topbar-right"><span className="api-pill"><span className="online-dot" /> Local API</span><div className="profile-avatar">HL</div></div>
        </header>

        <div className="page-content">
          {error && <div className="alert alert-error"><strong>Something went wrong</strong><span>{error}</span><button onClick={() => setError("")}>×</button></div>}
          {notice && <div className="alert alert-success"><span>✓</span><span>{notice}</span><button onClick={() => setNotice("")}>×</button></div>}

          {activePage === "Dashboard" && (
            <>
              <section className="welcome-row">
                <div><p className="eyebrow">RECRUITMENT OVERVIEW</p><h2>Your hiring workspace, at a glance.</h2><p>Review resumes, compare job-related evidence, and keep your shortlist organized.</p></div>
                <button className="button button-primary" onClick={() => goTo("Candidates")}>＋ Add candidates</button>
              </section>
              <section className="stat-grid">
                <StatCard label="Total candidates" value={stats.total_candidates ?? 0} hint="Resumes in your workspace" icon="♙" />
                <StatCard label="AI analyzed" value={stats.analyzed_candidates ?? 0} hint={`${stats.pending_analysis ?? 0} awaiting analysis`} icon="⌕" />
                <StatCard label="Ranked candidates" value={stats.ranked_candidates ?? 0} hint="Compared to a job description" icon="↗" />
                <StatCard label="Shortlisted" value={stats.shortlisted_candidates ?? 0} hint="Marked for further review" icon="✓" />
              </section>
              <section className="panel">
                <div className="panel-heading"><div><h3>Recent candidates</h3><p>Latest resumes added to HireLens AI</p></div><button className="button button-ghost" onClick={() => goTo("Candidates")}>View all <span>→</span></button></div>
                <CandidateTable candidates={candidates.slice(0, 6)} onStatus={updateStatus} onDelete={deleteCandidate} />
              </section>
              <div className="disclaimer">AI-generated analysis and match scores can be wrong. Verify evidence in the original resume and make hiring decisions through qualified human review.</div>
            </>
          )}

          {activePage === "Candidates" && (
            <>
              <section className="welcome-row compact"><div><p className="eyebrow">CANDIDATE DIRECTORY</p><h2>Manage your resume pool.</h2><p>Upload text-based PDF resumes, search records, and update review status.</p></div></section>
              <section className="panel upload-panel">
                <div className="panel-heading"><div><h3>Upload a resume</h3><p>PDF only · Maximum 10 MB per file</p></div><span className="panel-icon">↑</span></div>
                <form className="upload-form" onSubmit={uploadResume}>
                  <label className="file-drop"><input type="file" accept=".pdf,application/pdf" onChange={(e) => setSelectedFile(e.target.files?.[0] || null)} /><span className="file-icon">PDF</span><span><strong>{selectedFile ? selectedFile.name : "Choose a PDF resume"}</strong><small>{selectedFile ? `${(selectedFile.size / 1024 / 1024).toFixed(2)} MB selected` : "Select a file from your computer"}</small></span><span className="button button-secondary">Browse files</span></label>
                  <button className="button button-primary" type="submit" disabled={busy === "upload"}>{busy === "upload" ? "Uploading…" : "Upload resume"}</button>
                </form>
              </section>
              <section className="panel">
                <div className="panel-heading wrap-heading"><div><h3>All candidates <span className="count-badge">{candidates.length}</span></h3><p>Search and filter saved candidates</p></div>
                  <div className="table-tools"><input className="search-input" placeholder="Search name, email, file…" value={search} onChange={(e) => setSearch(e.target.value)} /><select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}><option>All</option><option>Shortlisted</option><option>Under Review</option><option>Not Selected</option></select></div>
                </div>
                <CandidateTable candidates={filteredCandidates} onStatus={updateStatus} onDelete={deleteCandidate} />
                {!filteredCandidates.length && <EmptyState title="No candidates found" text="Upload a PDF resume or adjust your search." />}
              </section>
            </>
          )}

          {activePage === "AI Screening" && (
            <>
              <section className="welcome-row compact"><div><p className="eyebrow">AI RESUME REVIEW</p><h2>Understand each resume against the role.</h2><p>Get job-related evidence and gaps for every uploaded candidate.</p></div></section>
              <section className="panel form-panel">
                <div className="panel-heading"><div><h3>Screen resumes</h3><p>The same job description is used for all candidates currently in the workspace.</p></div><span className="panel-icon">✦</span></div>
                <form onSubmit={analyzeAll} className="stack-form">
                  <label>Job description<textarea required minLength={20} maxLength={12000} rows={7} value={jobDescription} onChange={(e) => setJobDescription(e.target.value)} placeholder="Paste the role, required skills, responsibilities, and experience expectations…" /></label>
                  <div className="form-footer"><span className="muted">AI reviews job-related evidence only.</span><button className="button button-primary" disabled={busy === "analyze" || candidates.length === 0}>{busy === "analyze" ? "Analyzing resumes…" : "✦ Analyze all candidates"}</button></div>
                </form>
              </section>
              {analysisResults.length > 0 && <section className="panel"><div className="panel-heading"><div><h3>Latest analysis results</h3><p>{analysisResults.length} candidate(s) analyzed</p></div></div><div className="analysis-list">{analysisResults.map((item) => <article className="analysis-card" key={item.id}><div className="candidate-line"><div className="candidate-avatar">{initials(item.name)}</div><div><strong>{item.name}</strong><small>{item.filename}</small></div></div><pre>{item.analysis}</pre></article>)}</div></section>}
              <div className="disclaimer">This feature provides decision support, not a hiring decision. Confirm every important finding in the source resume.</div>
            </>
          )}

          {activePage === "Ranking & Shortlist" && (
            <>
              <section className="welcome-row compact"><div><p className="eyebrow">CANDIDATE COMPARISON</p><h2>Compare evidence. Organize your shortlist.</h2><p>Run ranking against one job description, then review and save each candidate's status.</p></div></section>
              <section className="panel form-panel">
                <div className="panel-heading"><div><h3>Rank candidates</h3><p>All uploaded candidates will be assessed independently against this role.</p></div><span className="panel-icon">↗</span></div>
                <form onSubmit={rankAll} className="stack-form">
                  <label>Job description<textarea required minLength={20} maxLength={12000} rows={6} value={rankJobDescription} onChange={(e) => setRankJobDescription(e.target.value)} placeholder="Paste the complete job description for this comparison…" /></label>
                  <div className="form-footer"><span className="muted">Scores use skills, experience, evidence, and alignment.</span><button className="button button-primary" disabled={busy === "rank" || candidates.length === 0}>{busy === "rank" ? "Ranking candidates…" : "↗ Rank candidates"}</button></div>
                </form>
              </section>
              {rankResults.length > 0 && <section className="panel"><div className="panel-heading"><div><h3>Ranking results</h3><p>Sorted by estimated job-related match score, highest first.</p></div><span className="count-badge">{rankResults.length} ranked</span></div><RankingTable results={rankResults} onStatus={updateStatus} busy={busy} /></section>}
              {rankResults.length === 0 && <section className="panel empty-panel"><div className="empty-illustration">↗</div><h3>Your ranking will appear here</h3><p>Upload at least one resume, enter a job description, and select <strong>Rank candidates</strong>.</p></section>}
              <div className="disclaimer">Match scores are AI-generated estimates, not objective measures of candidate quality. Review strengths, gaps, and the original resumes before making any decision.</div>
            </>
          )}

          {activePage === "Interview Questions" && (
            <>
              <section className="welcome-row compact"><div><p className="eyebrow">INTERVIEW PREPARATION</p><h2>Prepare role-specific interview questions.</h2><p>Generate practical questions and guidance for what a strong answer should demonstrate.</p></div></section>
              <section className="panel form-panel">
                <div className="panel-heading"><div><h3>Question generator</h3><p>Add a job description and optionally include the candidate's AI summary.</p></div><span className="panel-icon">☷</span></div>
                <form className="stack-form" onSubmit={generateQuestions}>
                  <label>Job description<textarea required minLength={20} maxLength={12000} rows={5} value={questionJob} onChange={(e) => setQuestionJob(e.target.value)} placeholder="Paste the job description…" /></label>
                  <label>Candidate summary <span className="optional-label">Optional</span><textarea rows={4} maxLength={12000} value={questionSummary} onChange={(e) => setQuestionSummary(e.target.value)} placeholder="Paste the candidate's AI analysis summary or relevant resume details…" /></label>
                  <div className="form-footer"><span className="muted">Generates 10 questions across multiple categories.</span><button className="button button-primary" disabled={busy === "questions"}>{busy === "questions" ? "Generating…" : "✦ Generate questions"}</button></div>
                </form>
              </section>
              {questions && <section className="panel"><div className="panel-heading"><div><h3>Generated interview guide</h3><p>Use these as a guide and ask consistent, role-related questions.</p></div><button className="button button-secondary" onClick={() => navigator.clipboard?.writeText(questions)}>Copy text</button></div><InterviewQuestionList input={questions} /></section>}
            </>
          )}
        </div>
      </main>
    </div>
  );
}

function StatCard({ label, value, hint, icon }) {
  return <article className="stat-card"><div className="stat-top"><span>{label}</span><span className="stat-icon">{icon}</span></div><strong className="stat-value">{value}</strong><span className="stat-hint">{hint}</span></article>;
}

function CandidateTable({ candidates, onStatus, onDelete }) {
  if (!candidates.length) return <EmptyState title="No candidates yet" text="Upload a PDF resume to begin building your candidate pool." />;
  return <div className="table-scroll"><table className="data-table"><thead><tr><th>Candidate</th><th>Resume</th><th>AI review</th><th>Match</th><th>Shortlist status</th><th>Actions</th></tr></thead><tbody>
    {candidates.map((candidate) => <tr key={candidate.id}>
      <td><div className="candidate-cell"><div className="candidate-avatar">{initials(candidate.name)}</div><div><strong>{candidate.name}</strong><small>{candidate.email || "Email not detected"}</small></div></div></td>
      <td><span className="file-name">{candidate.filename}</span></td>
      <td><span className={`mini-status ${candidate.analyzed ? "status-green" : "status-neutral"}`}>{candidate.analyzed ? "Analyzed" : "Pending"}</span></td>
      <td>{candidate.rank_score == null ? <span className="muted">—</span> : <strong className="score-inline">{Math.round(candidate.rank_score)}%</strong>}</td>
      <td><select className={`status-select ${statusClass(candidate.shortlist_status)}`} value={candidate.shortlist_status || "Under Review"} onChange={(e) => onStatus(candidate.id, e.target.value)}><option>Under Review</option><option>Shortlisted</option><option>Not Selected</option></select></td>
      <td><button className="icon-button danger-action" title="Delete candidate" onClick={() => onDelete(candidate)}>×</button></td>
    </tr>)}
  </tbody></table></div>;
}

function RankingTable({ results, onStatus, busy }) {
  return <div className="ranking-list">{results.map((candidate) => {
    const details = candidate.rank_details || {};
    return <article className="rank-card" key={candidate.id}>
      <div className="rank-position">#{candidate.rank}</div>
      <div className="rank-main">
        <div className="rank-heading"><div className="candidate-cell"><div className="candidate-avatar">{initials(candidate.name)}</div><div><strong>{candidate.name}</strong><small>{candidate.filename} {candidate.email ? `· ${candidate.email}` : ""}</small></div></div><div className="score-wrap"><strong>{candidate.rank_score}%</strong><span>match estimate</span></div></div>
        <div className="score-track"><span style={{ width: `${Math.max(0, Math.min(100, candidate.rank_score || 0))}%` }} /></div>
        <div className="score-breakdown">{[["Skills", details.skills_match], ["Experience", details.experience_match], ["Evidence", details.requirements_evidence], ["Alignment", details.overall_alignment]].map(([label, value]) => <div key={label}><span>{label}</span><strong>{value ?? 0}%</strong></div>)}</div>
        {details.rationale && <p className="rank-rationale">{details.rationale}</p>}
        <div className="rank-evidence-grid">
          <div><h4>Strengths evidenced</h4>{details.strengths?.length ? <ul>{details.strengths.map((item, i) => <li key={i}>{item}</li>)}</ul> : <p className="muted">No strengths returned.</p>}</div>
          <div><h4>Gaps / unclear</h4>{details.gaps_or_unclear?.length ? <ul>{details.gaps_or_unclear.map((item, i) => <li key={i}>{item}</li>)}</ul> : <p className="muted">No gaps returned.</p>}</div>
        </div>
        <div className="rank-footer"><span className={`mini-status ${statusClass(candidate.shortlist_status)}`}>{candidate.shortlist_status || "Under Review"}</span><label className="status-change">Update status <select value={candidate.shortlist_status || "Under Review"} disabled={busy === `status-${candidate.id}`} onChange={(e) => onStatus(candidate.id, e.target.value)}><option>Under Review</option><option>Shortlisted</option><option>Not Selected</option></select></label></div>
      </div>
    </article>;
  })}</div>;
}

function InterviewQuestionList({ input }) {
  const parsed = parseInterviewQuestions(input);
  if (!parsed.length) return <pre className="raw-questions">{input}</pre>;
  let number = 0;
  return <div className="questions-container">{parsed.map((item, index) => {
    if (!item.question) return <div className="question-section-title" key={`section-${index}`}>{item.section}<p>{item.guidance.join(" ")}</p></div>;
    number += 1;
    return <article className="question-card" key={`${item.section}-${index}`}><div className="question-number">{String(number).padStart(2, "0")}</div><div className="question-content"><span className="question-category">{item.section}</span><h4>{item.question}</h4>{item.guidance.length > 0 && <div className="expected-answer"><strong>What a strong answer should demonstrate</strong><p>{item.guidance.join(" ")}</p></div>}</div></article>;
  })}</div>;
}

function EmptyState({ title, text }) {
  return <div className="empty-state"><div className="empty-illustration">⌕</div><h3>{title}</h3><p>{text}</p></div>;
}
