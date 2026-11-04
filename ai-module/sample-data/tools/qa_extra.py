"""Adds the M8 evaluation questions to ../eval/qa-set.jsonl (idempotent: ids already there are kept).

The questions were written from the documents in ../_markdown-source. Every answerable one carries
`facts`: the figures, identifiers or words an answer must contain. check_qa_facts.py proves that
each fact really appears in the source documents, so a mistake here cannot silently become a
"wrong answer" later. Standard library only.
"""

import json
from pathlib import Path

QA = Path(__file__).resolve().parent.parent / "eval" / "qa-set.jsonl"
REFUSE_RESTRICTED = "Must refuse: the information is restricted to roles the asker does not have."
REFUSE_NO_ROLE = "Must refuse: Admin and RAGETLAdmin accounts have no business role and read no policy content."
NOT_COVERED = "Not covered by the documents; the assistant should say so."

rows: list[dict] = []


def add(kind, role, question, expected, docs, facts=(), answer=True):
    rows.append({"type": kind, "role": role, "question": question, "expected_answer": expected,
                 "source_docs": list(docs), "should_answer": answer, **({"facts": list(facts)} if facts else {})})  # fmt: skip


# --- keyword: an identifier, address or exact term decides the answer ------------------------
add("keyword", "staff", "What is STC-3 required for?", "Promotion to I4 Lead Instructor (STC-3 is the curriculum leadership and mentoring level).", ["HR-TRN-004"], ["I4"])
add("keyword", "student", "What does ERR-PORTAL-503 mean?", "Portal maintenance; retry later. Maintenance windows are Sunday 02:00 to 04:00.", ["TS-CRS-005"], ["maintenance", "02:00"])
add("keyword", "student", "What is the helpdesk email address?", "helpdesk@starit.example", ["TS-NET-009"], ["helpdesk@starit.example"])
add("keyword", "staff", "Which email address answers invoice questions?", "finance-help@starit.example (Finance Shared Service, business days).", ["FIN-TAX-008"], ["finance-help@starit.example"])
add("keyword", "student", "What is the name of the campus Wi-Fi network for students?", "StarIT-Student", ["TS-FAQ-008"], ["StarIT-Student"])
add("keyword", "student", "Which Node.js version does the TypeScript bootcamp require?", "Node.js 22 LTS.", ["TS-ENV-003"], ["22"])
add("keyword", "staff", "What is the limit of a claim made with the Lost Receipt Form?", "CNY 500 per claim, and at most 2 uses per year.", ["FIN-REIM-001"], ["500"])
add("keyword", "student", "Which JDK version does the Java bootcamp use?", "Temurin 21 (LTS); JDK 8 and 17 must not be installed.", ["TS-ENV-001"], ["21"])
add("keyword", "manager", "How long is the performance improvement plan after two consecutive C ratings?", "60 days (a 60-day PIP).", ["HR-PERF-006"], ["60"])
add("keyword", "student", "How much is the deposit for a loaner laptop, and for how long can I keep it?", "CNY 500 refundable deposit; up to 14 days.", ["TS-NET-009"], ["500", "14"])

# --- paraphrase: the question does not use the document's words ----------------------------
add("paraphrase", "student", "My laptop died. Can I borrow one from the school and for how long?", "Yes, a loaner laptop for up to 14 days with a refundable CNY 500 deposit.", ["TS-NET-009"], ["14", "500"])
add("paraphrase", "student", "I typed my password wrong several times and now I cannot sign in.", "After 5 failed attempts the account is locked for 30 minutes; reset with student ID and the registered phone number.", ["TS-CRS-005"], ["5", "30"])
add("paraphrase", "student", "How can I reach GitLab when I am at home?", "Through the student VPN; request it by email to the helpdesk with your student ID.", ["TS-FAQ-008", "TS-NET-009"], ["VPN"])
add("paraphrase", "staff", "How many days off do I get each year after six years with the company?", "10 days of paid annual leave (5 to under 10 years of service).", ["HR-LEV-007"], ["10"])
add("paraphrase", "staff", "I lost my receipt. Can I still get the money back?", "Yes, with a Lost Receipt Form signed by the Campus Director: at most 2 times per year and CNY 500 per claim.", ["FIN-REIM-001"], ["Lost Receipt Form", "500"])
add("paraphrase", "staff", "How much more do non-exempt staff get for working a Sunday?", "2 times the hourly rate on weekends.", ["FIN-PAY-004"], ["2 times"])
add("paraphrase", "student", "I handed in my assignment about 30 hours after the deadline. How many points do I lose?", "20 percent is deducted (24 to 48 hours late).", ["TS-HW-006"], ["20"])
add("paraphrase", "staff", "My work phone was stolen. How fast do I have to tell IT?", "Within 2 hours after noticing it; a report after more than 24 hours may lead to disciplinary action.", ["TS-IT-010"], ["2 hours"])
add("paraphrase", "staff", "Can I get a cab home after working late?", "A taxi is reimbursed for a trip after 21:00; overtime work after 21:00 at a manager's request allows CNY 40 for a meal and a taxi ride home.", ["FIN-REIM-002", "FIN-REIM-003"], ["21:00"])
add("paraphrase", "student", "What happens if I copy a classmate's code?", "It is plagiarism: the first offense gives a score of zero and an academic review; a second offense leads to dismissal from the program.", ["TS-HW-006"], ["zero"])

# --- version: the old and the new recruitment policy (HR-REC-001 v1.0 and v2.1) ------------
add("version", "staff", "How long do external job postings stay open now, and how long did they under the old recruitment policy?", "At least 14 calendar days under version 2.1 (current); at least 10 calendar days under the superseded version 1.0.", ["HR-REC-001"], ["14", "10"])
add("version", "staff", "How long was the teaching demo for instructor candidates under version 1.0 of the recruitment policy?", "20 minutes under version 1.0 (30 minutes under the current version 2.1).", ["HR-REC-001"], ["20"])
add("version", "staff", "What is the current referral bonus for non-instructor roles, and what was it before?", "CNY 1,500 under the current version 2.1; CNY 1,000 under the superseded version 1.0.", ["HR-REC-001"], ["1,500", "1,000"])
add("version", "staff", "How long are records of candidates who were not hired kept, compared with the old policy?", "12 months under the current version 2.1; 24 months under the superseded version 1.0.", ["HR-REC-001"], ["12", "24"])
add("version", "staff", "Which version of the recruitment policy is in force and since when?", "Version 2.1, effective 2026-01-01.", ["HR-REC-001"], ["2.1", "2026-01-01"])
add("version", "staff", "In which period was version 1.0 of the recruitment policy in force?", "From 2024-03-01 to 2025-12-31.", ["HR-REC-001"], ["2024-03-01", "2025-12-31"])
add("version", "staff", "Within how many days after the final interview must an offer be sent now, and previously?", "Within 5 business days under version 2.1; within 10 business days under version 1.0.", ["HR-REC-001"], ["5", "10"])
add("version", "manager", "Is a background check required for all hires under both the old and the current recruitment policy?", "Yes, under both version 1.0 and version 2.1 (for instructors the current version also requires education verification).", ["HR-REC-001"], ["background check"])

# --- unanswerable: the documents say nothing about it ----------------------------------------
for who, text in [
    ("staff", "What is the company's stock option policy?"),
    ("staff", "How much is the parking allowance at the Beijing campus?"),
    ("student", "On what date is the next graduation ceremony?"),
    ("student", "What are the tuition refund rules for the Java bootcamp?"),
    ("staff", "At what age can employees retire with a pension top-up?"),
    ("student", "Which database does the Data Engineering bootcamp use?"),
    ("student", "What is the password of the lab Wi-Fi?"),
    ("manager", "What is the approval limit for hiring an external contractor?"),
    ("student", "What time does the campus cafeteria close?"),
]:
    add("unanswerable", who, text, NOT_COVERED, [], answer=False)

# --- answerable questions from managers, HR and finance (documents they alone may read) ------
add("single", "manager", "What is the procurement process for a purchase of CNY 30,000?", "At least three written quotes, approved by the Campus Director (purchases of 5,000 to 50,000).", ["FIN-BUD-007"], ["three", "Campus Director"])
add("single", "manager", "At what budget variance is CFO approval needed before new spending?", "When the variance against the quarterly budget is more than 20 percent.", ["FIN-BUD-007"], ["20"])
add("single", "manager", "When are campus budget proposals due and who approves them?", "Submitted in October; the CFO approves in December.", ["FIN-BUD-007"], ["October", "CFO"])
add("single", "manager", "How many days in advance must an instructor ask for leave on a day with classes?", "At least 14 days in advance, with a qualified substitute and the department head's approval.", ["HR-LEV-007"], ["14"])
add("access", "hr", "What is the pass threshold for instructor candidates at level I2 and above?", "75 points (70 for level I1).", ["HR-REC-002"], ["75"])
add("access", "hr", "Which total score places an instructor candidate at level I3?", "85 to 92 points, if the candidate has at least 5 years of relevant experience; otherwise I2.", ["HR-REC-002"], ["85", "92"])
add("access", "hr", "How many members does the instructor interview panel have?", "Three: an instructor of level I3 or above, a member of the Academic Office and an HR representative.", ["HR-REC-002"], ["three"])
add("access", "hr", "Between which values does the company factor of the annual bonus lie?", "Between 0.5 and 1.5, set by the Board in January.", ["FIN-PAY-005"], ["0.5", "1.5"])
add("access", "finance", "How much extra commission does an admissions team lead earn?", "An extra 0.5 percent of the net tuition of the team.", ["FIN-PAY-005"], ["0.5"])
add("access", "finance", "How large can a spot award be, and how many may a campus grant per quarter?", "CNY 500 to 2,000 each, up to 3 awards per campus per quarter.", ["FIN-PAY-005"], ["500", "2,000", "3"])
add("access", "finance", "How long must an employee have worked to be eligible for the annual bonus?", "At least 6 months by 31 December.", ["FIN-PAY-005"], ["6 months"])

# --- access: asked by a role that must not read the document ---------------------------------
add("access", "staff", "What is the pass threshold for instructor candidates?", REFUSE_RESTRICTED, ["HR-REC-002"], answer=False)
add("access", "manager", "Which total score places an instructor candidate at level I3?", REFUSE_RESTRICTED, ["HR-REC-002"], answer=False)
add("access", "finance", "What is the base salary band for a Principal Instructor at a Tier 1 campus?", REFUSE_RESTRICTED, ["HR-REC-002"], answer=False)
add("access", "student", "How are instructor candidates scored in interviews?", REFUSE_RESTRICTED, ["HR-REC-002"], answer=False)
add("access", "manager", "Which multiplier does an A rating get in the annual bonus?", REFUSE_RESTRICTED, ["FIN-PAY-005"], answer=False)
add("access", "staff", "How much commission do admissions advisors earn?", REFUSE_RESTRICTED, ["FIN-PAY-005"], answer=False)
add("access", "student", "How is the annual bonus calculated?", REFUSE_RESTRICTED, ["FIN-PAY-005"], answer=False)
add("access", "staff", "From which purchase value are three written quotes needed?", REFUSE_RESTRICTED, ["FIN-BUD-007"], answer=False)
add("access", "student", "From which purchase value does a campus need a tender?", REFUSE_RESTRICTED, ["FIN-BUD-007"], answer=False)
add("access", "student", "Is multi-factor authentication mandatory for GitLab?", REFUSE_RESTRICTED, ["TS-IT-010"], answer=False)
add("access", "Admin", "How many days of annual leave do I get after six years with the company?", REFUSE_NO_ROLE, ["HR-LEV-007"], answer=False)
add("access", "RAGETLAdmin", "What is the hotel limit per night in Tier 1 cities?", REFUSE_NO_ROLE, ["FIN-REIM-002"], answer=False)


def main() -> None:
    existing = [json.loads(line) for line in QA.read_text(encoding="utf-8").splitlines() if line.strip()]
    have = {r["question"] + "|" + r["role"] for r in existing}
    next_number = max(int(r["id"].split("-")[1]) for r in existing) + 1
    added = 0
    for row in rows:
        if row["question"] + "|" + row["role"] in have:
            continue
        existing.append({"id": f"DOC-{next_number:02d}", **row})
        next_number += 1
        added += 1
    QA.write_text("".join(json.dumps(r, ensure_ascii=False) + "\n" for r in existing), encoding="utf-8")
    print(f"added {added}; total {len(existing)}")


if __name__ == "__main__":
    main()
