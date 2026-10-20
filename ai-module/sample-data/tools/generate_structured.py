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
add_emp("CD", "Human Resources", "HR Business Partner", "S3", rdate(2016, 2022))
add_emp("CD", "Finance", "Finance Controller", "M2", rdate(2015, 2020))
add_emp("CD", "Finance", "Accountant", "S2", rdate(2018, 2024))
add_emp("CD", "IT and Technical Support", "Helpdesk Engineer", "S2", rdate(2018, 2025))
add_emp("CD", "Academic Office", "Principal Instructor", "I5", rdate(2014, 2019))
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
write("support_tickets.csv", tickets)

# ---------------------------------------------------------------- students, assignments, submissions
PROGRAMS = ["java", "python", "typescript"]
students = []
for i in range(1, 61):
    c = rnd.choice(CAMPUSES)[0]
    students.append({"student_id": f"S{i:04d}", "name": name(), "campus_id": c, "program": rnd.choice(PROGRAMS),
                     "cohort": "2026S1", "status": rnd.choices(["active", "withdrawn"], [95, 5])[0]})
write("students.csv", students)

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

# ---------------------------------------------------------------- reference answers for SQL-style questions
qa = []


def q(question, answer, tables):
    qa.append({"id": f"SQL-{len(qa) + 1:02d}", "type": "sql", "question": question,
               "expected_answer": str(answer), "tables": tables, "access": "finance-and-hr"
               if "claims" in tables[0] or "employees" in tables[0] else "staff"})


def mdays(c):
    return (date.fromisoformat(c["submitted_date"]) - date.fromisoformat(c["expense_date"])).days


over_hotel = [c for c in claims if c["category"] == "TRAVEL-HOTEL"
              and int(c["amount_cny"]) / int(c["nights_or_days"]) > HOTEL_CAP[
                  next(x[2] for x in CAMPUSES if x[1] == c["city"])]]
q("How many hotel claims exceed the nightly hotel limit in FIN-REIM-002?", len(over_hotel), ["expense_claims"])
q("List the claim IDs of hotel claims that exceed the nightly hotel limit.",
  ", ".join(sorted(c["claim_id"] for c in over_hotel)), ["expense_claims"])
late = [c for c in claims if mdays(c) > 30]
q("How many expense claims were submitted more than 30 days after the expense date?", len(late), ["expense_claims"])
q("How many expense claims were submitted more than 90 days after the expense date (and must be rejected)?",
  len([c for c in claims if mdays(c) > 90]), ["expense_claims"])
ent_bad = [c for c in claims if c["category"] == "ENTERTAIN" and int(c["amount_cny"]) / int(c["guests"]) > 300]
q("How many entertainment claims exceed CNY 300 per person?", len(ent_bad), ["expense_claims"])
teach_bad = [c for c in claims if c["category"] == "TEACH" and c["preapproved"] == "no" and int(c["amount_cny"]) > 500]
q("How many teaching-supply claims above CNY 500 were made without pre-approval?", len(teach_bad), ["expense_claims"])
bj_paid = sum(int(c["amount_cny"]) for c in claims if c["campus_id"] == "BJ" and c["status"] == "paid")
q("What is the total amount in CNY of paid expense claims for the Beijing campus?", bj_paid, ["expense_claims"])
by_cat = {}
for c in claims:
    by_cat[c["category"]] = by_cat.get(c["category"], 0) + int(c["amount_cny"])
top = max(by_cat, key=by_cat.get)
q("Which expense category has the highest total amount across all claims, and what is the total?",
  f"{top}: {by_cat[top]}", ["expense_claims"])
p1_miss = [t for t in tickets if t["priority"] == "P1" and t["first_response_minutes"] > 30]
q("How many P1 tickets missed the 30-minute first-response target in TS-NET-009?", len(p1_miss), ["support_tickets"])
p2_miss = [t for t in tickets if t["priority"] == "P2" and t["first_response_minutes"] > 240]
q("How many P2 tickets missed the 4-hour first-response target?", len(p2_miss), ["support_tickets"])
q("How many tickets were opened by students and how many by staff?",
  f"students: {sum(t['requester_type'] == 'student' for t in tickets)}, "
  f"staff: {sum(t['requester_type'] == 'staff' for t in tickets)}", ["support_tickets"])
late_subs = [s for s in subs if s["hours_late"] > 0]
q("How many submissions were late, according to the portal records?", len(late_subs), ["submissions"])
zero = [s for s in subs if s["hours_late"] > 72]
q("How many submissions received a score of zero because they were more than 72 hours late?", len(zero),
  ["submissions"])
inst = [e for e in employees if e["department"] == "Academic" and e["level"] in ("I1", "I2", "I3", "I4", "I5")]
q("How many instructors (levels I1 to I5) work at the Shenzhen campus?",
  len([e for e in inst if e["campus_id"] == "SZ"]), ["employees"])
q("How many employees in total are in the employees table?", len(employees), ["employees"])
act = [s for s in students if s["status"] == "active" and s["program"] == "java"]
q("How many active students are enrolled in the Java program?", len(act), ["students"])

with open(EVAL / "sql-qa.jsonl", "w", encoding="utf-8") as f:
    for r in qa:
        f.write(json.dumps(r, ensure_ascii=False) + "\n")

print({"employees": len(employees), "claims": len(claims), "tickets": len(tickets), "students": len(students),
       "submissions": len(subs), "sql_questions": len(qa)})
