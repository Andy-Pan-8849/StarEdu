---
doc_id: TS-ENV-001
title: Java Development Environment Setup
domain: tech-support
version: 4.1
status: active
effective_date: 2026-02-01
access: students-and-staff
campus_scope: all
format: md
---

# Java Development Environment Setup

This guide is for students of the Java Full-Stack Bootcamp. Follow the steps in order on Windows 11, macOS or Ubuntu 22.04.

## 1. Required versions

| Tool | Version |
|---|---|
| JDK | Temurin 21 (LTS) |
| Maven | 3.9.9 |
| IDE | IntelliJ IDEA Community Edition (latest stable) |
| Database | MySQL 8.4 |
| Git | 2.40 or newer |

Do not install JDK 8 or 17. The course material and the autograder use Java 21.

## 2. Install the JDK

1. Download Temurin 21 from the course portal (Tools > Java) or from the official Adoptium site.
2. Install it with the default options.
3. Set the environment variable `JAVA_HOME` to the installation folder, and add `%JAVA_HOME%\bin` (Windows) or `$JAVA_HOME/bin` (macOS and Linux) to `PATH`.
4. Open a new terminal and check: `java -version` must print version 21.

## 3. Install Maven and use the campus mirror

1. Unpack Maven 3.9.9 to a folder without spaces, for example `C:\tools\maven` or `~/tools/maven`.
2. Add its `bin` folder to `PATH`. Check with `mvn -v`.
3. Open `~/.m2/settings.xml` (create it if it does not exist) and add the StarIT mirror, which is much faster than Maven Central on campus networks:

```
<mirror>
  <id>starit</id>
  <mirrorOf>central</mirrorOf>
  <url>https://maven.starit.example/repository/public/</url>
</mirror>
```

## 4. Install IntelliJ IDEA

Install IntelliJ IDEA Community Edition. In File > Project Structure, set the project SDK to the Temurin 21 folder. In Settings > Build Tools > Maven, point "Maven home path" to your Maven folder and "User settings file" to your `settings.xml`.

## 5. Install MySQL 8.4

Install MySQL 8.4 with the default port 3306. Set a root password and write it down. Create the course database with `CREATE DATABASE starit_course CHARACTER SET utf8mb4;`.

## 6. Verify the setup

Clone the check project from `https://git.starit.example/java/env-check.git` and run `mvn test`. All tests must pass. If not, see the troubleshooting guide TS-FAQ-008 or contact the helpdesk (TS-NET-009).
