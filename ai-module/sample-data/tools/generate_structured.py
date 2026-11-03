#!/usr/bin/env python3
"""Generate the synthetic StarIT structured data (CSV) and the reference answers for
the SQL-style evaluation questions. Deterministic (fixed seed), standard library only.

Writes ../structured/*.csv and ../eval/sql-qa.jsonl
All people, IDs and amounts are fictional.
"""
import csv
import json
import random
from datetime import date, datetime, timedelta
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "structured"
EVAL = ROOT / "eval"
OUT.mkdir(exist_ok=True)
EVAL.mkdir(exist_ok=True)
rnd = random.Random(20261019)

CAMPUSES = [  # id, name, tier, region, opened
    ("BJ", "Beijing", 1, "North", 2013), ("SH", "Shanghai", 1, "East", 2014),
    ("SZ", "Shenzhen", 1, "South", 2015), ("GZ", "Guangzhou", 1, "South", 2016),
    ("HZ", "Hangzhou", 2, "East", 2017), ("CD", "Chengdu", 2, "West", 2012),
    ("WH", "Wuhan", 2, "Central", 2018), ("XA", "Xi'an", 2, "West", 2019),
]
TIER = {c[0]: c[2] for c in CAMPUSES}
CITY = {c[0]: c[1] for c in CAMPUSES}
FIRST = ["Wei", "Lei", "Jing", "Min", "Hao", "Yan", "Tao", "Xin", "Fang", "Jun", "Ling", "Bo", "Qing", "Chen",
         "Yu", "Hui", "Kai", "Mei", "Ning", "Peng"]
LAST = ["Wang", "Li", "Zhang", "Liu", "Chen", "Yang", "Zhao", "Huang", "Zhou", "Wu", "Xu", "Sun", "Ma", "Zhu",
        "Hu", "Guo", "He", "Lin", "Gao", "Luo"]


def name():
    return f"{rnd.choice(FIRST)} {rnd.choice(LAST)}"


def write(fname, rows):
    with open(OUT / fname, "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=list(rows[0].keys()))
        w.writeheader()
        w.writerows(rows)


# ---------------------------------------------------------------- campuses
campus_rows = [{"campus_id": c[0], "name": c[1], "city_tier": c[2], "region": c[3], "opened_year": c[4]}
               for c in CAMPUSES]
write("campuses.csv", campus_rows)

# ---------------------------------------------------------------- employees
employees = []
n = 1


def add_emp(campus, dept, title, level, hire):
    global n
    employees.append({"employee_id": f"E{n:04d}", "name": name(), "campus_id": campus, "department": dept,
                      "title": title, "level": level, "hire_date": hire.isoformat(), "status": "active"})
    n += 1


def rdate(y0, y1):
    d0, d1 = date(y0, 1, 1), date(y1, 9, 30)
    return d0 + timedelta(days=rnd.randrange((d1 - d0).days))


for c in CAMPUSES:
    cid = c[0]
    add_emp(cid, "Campus Management", "Campus Director", "M3", rdate(2014, 2020))
    for dept, head in [("Academic", "Department Head"), ("Admissions and Student Services", "Department Head"),
                       ("Career Services", "Department Head"), ("Campus Operations", "Department Head")]:
        add_emp(cid, dept, head, "M2", rdate(2015, 2021))
    for lvl, title, cnt in [("I1", "Junior Instructor", 2), ("I2", "Instructor", 3), ("I3", "Senior Instructor", 2),
                            ("I4", "Lead Instructor", 1)]:
        for _ in range(cnt):
            add_emp(cid, "Academic", title, lvl, rdate(2016, 2026))
    for _ in range(2):
        add_emp(cid, "Admissions and Student Services", "Admissions Advisor", "S2", rdate(2019, 2026))
    add_emp(cid, "Career Services", "Career Coach", "S2", rdate(2019, 2026))
    add_emp(cid, "Campus Operations", "Operations Assistant", "S1", rdate(2020, 2026))
# Headquarters functions sit in Beijing.
add_emp("BJ", "Human Resources", "HR Business Partner", "S3", rdate(2016, 2022))
add_emp("BJ", "Finance", "Finance Controller", "M2", rdate(2015, 2020))
add_emp("BJ", "Finance", "Accountant", "S2", rdate(2018, 2024))
add_emp("BJ", "IT and Technical Support", "Helpdesk Engineer", "S2", rdate(2018, 2025))
add_emp("BJ", "Academic Office", "Principal Instructor", "I5", rdate(2014, 2019))
write("employees.csv", employees)
EMP_BY_ID = {e["employee_id"]: e for e in employees}
claimants = [e for e in employees if e["department"] in ("Academic", "Admissions and Student Services",
                                                         "Career Services", "Campus Operations")]

# ---------------------------------------------------------------- expense claims
HOTEL_CAP = {1: 600, 2: 450}


def approver(amount):
    if amount <= 1000:
        return "Department Head"
    if amount <= 10000:
        return "Campus Director"
    return "Regional VP and Finance Controller"


claims, cn = [], 1


def add_claim(emp, cat, amount, exp_date, **kw):
    global cn
    delay = kw.pop("delay", rnd.randint(2, 20))
    sub = exp_date + timedelta(days=delay)
    status = rnd.choices(["paid", "approved", "pending", "rejected"], [60, 15, 15, 10])[0]
    if delay > 90:
        status = "rejected"
    claims.append({"claim_id": f"C{cn:04d}", "employee_id": emp["employee_id"], "campus_id": emp["campus_id"],
                   "category": cat, "city": kw.get("city", ""), "nights_or_days": kw.get("units", ""),
                   "guests": kw.get("guests", ""), "amount_cny": amount, "expense_date": exp_date.isoformat(),
                   "submitted_date": sub.isoformat(), "preapproved": kw.get("pre", ""),
                   "status": status, "approver_role": approver(amount)})
    cn += 1


def exp_date():
    return date(2026, 3, 1) + timedelta(days=rnd.randrange(0, 180))


for _ in range(34):  # hotels
    e = rnd.choice(claimants)
    city_id = rnd.choice(CAMPUSES)[0]
    cap, nights = HOTEL_CAP[TIER[city_id]], rnd.randint(1, 4)
    rate = round(cap * rnd.uniform(0.6, 1.0))
    add_claim(e, "TRAVEL-HOTEL", rate * nights, exp_date(), city=CITY[city_id], units=nights)
for _ in range(5):  # hotel over cap
    e = rnd.choice(claimants)
    city_id = rnd.choice(CAMPUSES)[0]
    cap, nights = HOTEL_CAP[TIER[city_id]], rnd.randint(1, 3)
    rate = round(cap * rnd.uniform(1.15, 1.4))
    add_claim(e, "TRAVEL-HOTEL", rate * nights, exp_date(), city=CITY[city_id], units=nights)
for _ in range(16):
    e = rnd.choice(claimants)
    days = rnd.randint(1, 5)
    add_claim(e, "TRAVEL-MEAL", days * 100, exp_date(), units=days)
for _ in range(14):
    e = rnd.choice(claimants)
    add_claim(e, "TRAVEL-TRANSPORT", rnd.randrange(150, 2200, 10), exp_date())
for _ in range(10):
    e = rnd.choice([x for x in claimants if x["level"] in ("M2", "M3")])
    g = rnd.randint(2, 6)
    add_claim(e, "ENTERTAIN", g * rnd.randrange(120, 300, 10), exp_date(), guests=g, pre="yes")
for _ in range(4):
    e = rnd.choice([x for x in claimants if x["level"] in ("M2", "M3")])
    g = rnd.randint(2, 5)
    add_claim(e, "ENTERTAIN", g * rnd.randrange(340, 520, 10), exp_date(), guests=g, pre="yes")
for _ in range(10):
    e = rnd.choice([x for x in claimants if x["department"] == "Academic"])
    add_claim(e, "TEACH", rnd.randrange(60, 500, 10), exp_date(), pre="no")
for _ in range(3):
    e = rnd.choice([x for x in claimants if x["department"] == "Academic"])
    add_claim(e, "TEACH", rnd.randrange(560, 900, 10), exp_date(), pre="no")
for _ in range(5):
    e = rnd.choice([x for x in claimants if x["department"] == "Academic"])
    add_claim(e, "CERT", rnd.randrange(800, 4800, 100), exp_date(), pre="yes")
for _ in range(6):  # late submissions
    e = rnd.choice(claimants)
    add_claim(e, "TRAVEL-TRANSPORT", rnd.randrange(200, 900, 10), exp_date(), delay=rnd.randint(35, 80))
add_claim(rnd.choice(claimants), "TRAVEL-TRANSPORT", 420, date(2026, 3, 5), delay=104)
write("expense_claims.csv", claims)

# ---------------------------------------------------------------- tickets
tickets = []
CATS = ["login", "environment", "portal", "git", "network", "hardware"]
for i in range(1, 71):
    stu = rnd.random() < 0.8
    emp = rnd.choice(employees)
    campus = rnd.choice(CAMPUSES)[0]
    prio = rnd.choices(["P1", "P2", "P3"], [8, 37, 55])[0]
    day = date(2026, 3, 1) + timedelta(days=rnd.randrange(0, 200))
    while day.weekday() == 6:
        day += timedelta(days=1)
    created = datetime(day.year, day.month, day.day, rnd.randint(8, 21), rnd.randrange(0, 60))
    sla_resp = {"P1": 30, "P2": 240, "P3": 1440}[prio]
    resp = int(sla_resp * (rnd.uniform(1.1, 1.8) if rnd.random() < 0.12 else rnd.uniform(0.1, 0.95)))
    sla_res = {"P1": 240, "P2": 1440, "P3": 4320}[prio]
    res = int(sla_res * rnd.uniform(0.2, 1.3))
    tickets.append({"ticket_id": f"T{i:04d}", "requester_type": "student" if stu else "staff",
                    "requester_id": f"S{rnd.randint(1, 60):04d}" if stu else emp["employee_id"],
                    "campus_id": campus, "category": rnd.choice(CATS), "priority": prio,
                    "created_at": created.isoformat(sep=" "),
                    "first_response_minutes": resp, "resolution_minutes": res, "status": "closed"})

# ---------------------------------------------------------------- students, assignments, submissions
PROGRAMS = ["java", "python", "typescript"]
students = []
for i in range(1, 61):
    c = rnd.choice(CAMPUSES)[0]
    students.append({"student_id": f"S{i:04d}", "name": name(), "campus_id": c, "program": rnd.choice(PROGRAMS),
                     "cohort": "2026S1", "status": rnd.choices(["active", "withdrawn"], [95, 5])[0]})
write("students.csv", students)

# A ticket belongs to the campus of the person who opened it. Done after the random draws
# so the rest of the data does not change.
STUDENT_BY_ID = {x["student_id"]: x for x in students}
for t in tickets:
    owner = STUDENT_BY_ID[t["requester_id"]] if t["requester_type"] == "student" else EMP_BY_ID[t["requester_id"]]
    t["campus_id"] = owner["campus_id"]
write("support_tickets.csv", tickets)

assignments = []
for p in PROGRAMS:
    for k in range(1, 5):
        assignments.append({"assignment_id": f"{p[:2].upper()}-A{k:02d}", "program": p,
                            "title": f"{p.capitalize()} assignment {k}",
                            "due_date": (date(2026, 4, 3) + timedelta(days=14 * (k - 1))).isoformat()})
write("assignments.csv", assignments)

subs = []
sn = 1
for s in students:
    if s["status"] != "active":
        continue
    for a in [x for x in assignments if x["program"] == s["program"]]:
        if rnd.random() < 0.06:
            continue  # never submitted
        due = datetime.fromisoformat(a["due_date"] + " 23:59")
        late_h = 0 if rnd.random() < 0.85 else rnd.randint(1, 90)
        sub_at = due + timedelta(hours=late_h) if late_h else due - timedelta(hours=rnd.randint(1, 60))
        raw = rnd.randint(55, 100)
        pen = 0 if late_h == 0 else 10 if late_h <= 24 else 20 if late_h <= 48 else 30 if late_h <= 72 else 100
        subs.append({"submission_id": f"SUB{sn:04d}", "student_id": s["student_id"],
                     "assignment_id": a["assignment_id"], "submitted_at": sub_at.isoformat(sep=" "),
                     "hours_late": late_h, "raw_score": raw, "late_penalty_pct": pen,
                     "final_score": round(raw * (100 - pen) / 100)})
        sn += 1
write("submissions.csv", subs)

# ---------------------------------------------------------------- job levels and demo accounts
# Three ladders are mapped onto one grade so a document can require "grade 4 and above".
LEVEL_RANK = {"S1": 1, "I1": 1, "S2": 2, "I2": 2, "S3": 3, "I3": 3, "I4": 4, "I5": 5, "M2": 6, "M3": 7}

# (subject id, role, function code used in the account name) - see README for the naming rule
DEMO = [
    ("S0018", "student", "stu"),
    ("E0014", "staff", "adm"),
    ("E0025", "staff", "acad"),
    ("E0001", "manager", "mgr"),
    ("E0018", "manager", "mgr"),
    ("E0137", "hr", "hr"),
    ("E0138", "finance", "fin"),
    ("E0140", "Admin", "admin"),
    ("E0141", "RAGETLAdmin", "ragetl"),
]
EXPECT = {  # guard: the demo accounts must keep pointing at the intended people
    "S0018": ("SH", "student"), "E0014": ("BJ", "Admissions Advisor"), "E0025": ("SH", "Instructor"),
    "E0001": ("BJ", "Campus Director"), "E0018": ("SH", "Campus Director"),
    "E0137": ("BJ", "HR Business Partner"), "E0138": ("BJ", "Finance Controller"),
    "E0140": ("BJ", "Helpdesk Engineer"), "E0141": ("BJ", "Principal Instructor"),
}
STUDENT_BY_ID = {x["student_id"]: x for x in students}
accounts = []
for sid, role, func in DEMO:
    person = STUDENT_BY_ID[sid] if sid.startswith("S") else EMP_BY_ID[sid]
    campus, title = person["campus_id"], person.get("title", "student")
    assert EXPECT[sid] == (campus, title), (sid, campus, title)
    level = person.get("level", "")
    accounts.append({"username": f"{person['name'].split()[0].lower()}.{func}.{campus.lower()}", "role": role,
                     "subject_type": "student" if sid.startswith("S") else "employee", "subject_id": sid,
                     "name": person["name"], "campus_id": campus, "level": level,
                     "level_rank": LEVEL_RANK.get(level, ""), "title": title})
assert len({a["username"] for a in accounts}) == len(accounts)
with open(ROOT / "demo-accounts.csv", "w", newline="", encoding="utf-8") as f:
    w = csv.DictWriter(f, fieldnames=list(accounts[0].keys()))
    w.writeheader()
    w.writerows(accounts)
ACCOUNT = {a["role"] + ":" + a["campus_id"] + ":" + a["subject_id"]: a for a in accounts}
WHO = {a["username"].split(".")[1] + "." + a["campus_id"].lower(): a for a in accounts}


# ---------------------------------------------------------------- data scope (who may see which rows)
# Policy documents are company-wide and controlled by role (documents/manifest.csv, `access`).
# Structured data is controlled by data scope: hr and finance see every campus (headquarters
# functions); staff and managers see their own campus; students see their own records;
# Admin and RAGETLAdmin see no business data. Employees and expense claims are narrower:
# a staff member sees only their own rows, a manager sees the campus.
COMPANY_WIDE = {"hr", "finance"}
TABLES = {"employees": employees, "expense_claims": claims, "support_tickets": tickets,
          "students": students, "submissions": subs, "assignments": assignments, "campuses": campus_rows}


def visible(table, who):
    rows = TABLES[table]
    role, campus, sid = who["role"], who["campus_id"], who["subject_id"]
    if table in ("campuses", "assignments"):
        return rows
    if role not in ("student", "staff", "manager", "hr", "finance"):
        return []
    if role in COMPANY_WIDE:
        return rows
    if table in ("employees", "expense_claims"):
        if role == "manager":
            return [r for r in rows if r["campus_id"] == campus]
        if role == "staff":
            return [r for r in rows if r.get("employee_id") == sid]
        return []
    if table == "students":
        if role in ("staff", "manager"):
            return [r for r in rows if r["campus_id"] == campus]
        return [r for r in rows if r["student_id"] == sid]
    if table == "support_tickets":
        if role in ("staff", "manager"):
            return [r for r in rows if r["campus_id"] == campus]
        return [r for r in rows if r["requester_id"] == sid]
    if table == "submissions":
        if role in ("staff", "manager"):
            ids = {x["student_id"] for x in students if x["campus_id"] == campus}
            return [r for r in rows if r["student_id"] in ids]
        return [r for r in rows if r["student_id"] == sid]
    return []


# ---------------------------------------------------------------- reference answers for SQL-style questions
qa = []
REFUSE = "Must refuse: the asker's role and campus do not allow access to this data."


def ask(who_key, question, answer, tables, *, scope):
    who = WHO[who_key]
    qa.append({"id": f"SQL-{len(qa) + 1:02d}", "type": "sql" if answer is not None else "sql-scope",
               "question": question, "expected_answer": REFUSE if answer is None else str(answer),
               "tables": tables, "asker": who["username"], "role": who["role"], "scope": scope,
               "should_answer": answer is not None})


def mdays(c):
    return (date.fromisoformat(c["submitted_date"]) - date.fromisoformat(c["expense_date"])).days


FIN, HR = "fin.bj", "hr.bj"
# Company-wide questions, asked by the headquarters functions that may see every campus.
cl = visible("expense_claims", WHO[FIN])
over_hotel = [c for c in cl if c["category"] == "TRAVEL-HOTEL"
              and int(c["amount_cny"]) / int(c["nights_or_days"]) > HOTEL_CAP[
                  next(x[2] for x in CAMPUSES if x[1] == c["city"])]]
ask(FIN, "How many hotel claims exceed the nightly hotel limit in FIN-REIM-002?", len(over_hotel),
    ["expense_claims"], scope="company")
ask(FIN, "List the claim IDs of hotel claims that exceed the nightly hotel limit.",
    ", ".join(sorted(c["claim_id"] for c in over_hotel)), ["expense_claims"], scope="company")
ask(FIN, "How many expense claims were submitted more than 30 days after the expense date?",
    len([c for c in cl if mdays(c) > 30]), ["expense_claims"], scope="company")
ask(FIN, "How many expense claims were submitted more than 90 days after the expense date (and must be rejected)?",
    len([c for c in cl if mdays(c) > 90]), ["expense_claims"], scope="company")
ask(FIN, "How many entertainment claims exceed CNY 300 per person?",
    len([c for c in cl if c["category"] == "ENTERTAIN" and int(c["amount_cny"]) / int(c["guests"]) > 300]),
    ["expense_claims"], scope="company")
ask(FIN, "How many teaching-supply claims above CNY 500 were made without pre-approval?",
    len([c for c in cl if c["category"] == "TEACH" and c["preapproved"] == "no" and int(c["amount_cny"]) > 500]),
    ["expense_claims"], scope="company")
ask(FIN, "What is the total amount in CNY of paid expense claims for the Beijing campus?",
    sum(int(c["amount_cny"]) for c in cl if c["campus_id"] == "BJ" and c["status"] == "paid"),
    ["expense_claims"], scope="company")
by_cat = {}
for c in cl:
    by_cat[c["category"]] = by_cat.get(c["category"], 0) + int(c["amount_cny"])
top = max(by_cat, key=by_cat.get)
ask(FIN, "Which expense category has the highest total amount across all claims, and what is the total?",
    f"{top}: {by_cat[top]}", ["expense_claims"], scope="company")
tk = visible("support_tickets", WHO[HR])
ask(HR, "How many P1 tickets missed the 30-minute first-response target in TS-NET-009?",
    len([t for t in tk if t["priority"] == "P1" and t["first_response_minutes"] > 30]),
    ["support_tickets"], scope="company")
ask(HR, "How many P2 tickets missed the 4-hour first-response target?",
    len([t for t in tk if t["priority"] == "P2" and t["first_response_minutes"] > 240]),
    ["support_tickets"], scope="company")
ask(HR, "How many tickets were opened by students and how many by staff?",
    f"students: {sum(t['requester_type'] == 'student' for t in tk)}, "
    f"staff: {sum(t['requester_type'] == 'staff' for t in tk)}", ["support_tickets"], scope="company")
sb = visible("submissions", WHO[HR])
ask(HR, "How many submissions were late, according to the portal records?",
    len([s for s in sb if s["hours_late"] > 0]), ["submissions"], scope="company")
ask(HR, "How many submissions received a score of zero because they were more than 72 hours late?",
    len([s for s in sb if s["hours_late"] > 72]), ["submissions"], scope="company")
em = visible("employees", WHO[HR])
ask(HR, "How many instructors (levels I1 to I5) work at the Shenzhen campus?",
    len([e for e in em if e["department"] == "Academic" and e["level"] in ("I1", "I2", "I3", "I4", "I5")
         and e["campus_id"] == "SZ"]), ["employees"], scope="company")
ask(HR, "How many employees in total are in the employees table?", len(em), ["employees"], scope="company")
ask(HR, "How many active students are enrolled in the Java program?",
    len([s for s in visible("students", WHO[HR]) if s["status"] == "active" and s["program"] == "java"]),
    ["students"], scope="company")

# Campus-scoped questions: the answer is computed from the rows this asker may see.
SHS, BJS, SHM, BJM, STU = "acad.sh", "adm.bj", "mgr.sh", "mgr.bj", "stu.sh"
t_sh = visible("support_tickets", WHO[SHS])
ask(SHS, "How many tickets at my campus missed their first-response target? "
    "(P1 30 minutes, P2 4 hours, P3 24 hours, as in TS-NET-009)",
    len([t for t in t_sh if t["first_response_minutes"] > {"P1": 30, "P2": 240, "P3": 1440}[t["priority"]]]),
    ["support_tickets"], scope="campus")
ask(SHS, "How many submissions from students at my campus were late?",
    len([s for s in visible("submissions", WHO[SHS]) if s["hours_late"] > 0]), ["submissions"], scope="campus")
ask(SHS, "How many active students are enrolled in the Python program at my campus?",
    len([s for s in visible("students", WHO[SHS]) if s["status"] == "active" and s["program"] == "python"]),
    ["students"], scope="campus")
t_bj = visible("support_tickets", WHO[BJS])
ask(BJS, "How many tickets at my campus were opened by students and how many by staff?",
    f"students: {sum(t['requester_type'] == 'student' for t in t_bj)}, "
    f"staff: {sum(t['requester_type'] == 'staff' for t in t_bj)}", ["support_tickets"], scope="campus")
own = visible("expense_claims", WHO[BJS])
ask(BJS, "How many expense claims have I submitted, and what is their total amount in CNY?",
    f"{len(own)} claims, CNY {sum(int(c['amount_cny']) for c in own)}", ["expense_claims"], scope="own")
ask(SHM, "How many employees work at my campus?", len(visible("employees", WHO[SHM])), ["employees"],
    scope="campus")
ask(BJM, "How many employees work at my campus?", len(visible("employees", WHO[BJM])), ["employees"],
    scope="campus")
ask(SHM, "What is the total amount in CNY of paid expense claims from my campus?",
    sum(int(c["amount_cny"]) for c in visible("expense_claims", WHO[SHM]) if c["status"] == "paid"),
    ["expense_claims"], scope="campus")
mine = visible("submissions", WHO[STU])
ask(STU, "How many assignments have I submitted?", len(mine), ["submissions"], scope="own")
ask(STU, "What is the average of my final scores?",
    round(sum(s["final_score"] for s in mine) / len(mine), 1), ["submissions"], scope="own")

# Scope and permission checks: the assistant must refuse or report that it has no such data.
ask(SHS, "How many employees work at the Beijing campus?", None, ["employees"], scope="campus")
ask(SHS, "What is the total amount in CNY of paid expense claims for the Beijing campus?", None,
    ["expense_claims"], scope="campus")
ask(SHM, "How many students are enrolled at the Beijing campus?", None, ["students"], scope="campus")
ask(STU, "How many expense claims were submitted more than 30 days after the expense date?", None,
    ["expense_claims"], scope="own")
ask(STU, "How many instructors (levels I1 to I5) work at my campus?", None, ["employees"], scope="own")
ask("admin.bj", "How many employees in total are in the employees table?", None, ["employees"], scope="none")
ask("ragetl.bj", "How many active students are enrolled in the Java program?", None, ["students"], scope="none")

with open(EVAL / "sql-qa.jsonl", "w", encoding="utf-8") as f:
    for r in qa:
        f.write(json.dumps(r, ensure_ascii=False) + "\n")

print({"employees": len(employees), "claims": len(claims), "tickets": len(tickets), "students": len(students),
       "submissions": len(subs), "sql_questions": len(qa), "accounts": len(accounts)})
