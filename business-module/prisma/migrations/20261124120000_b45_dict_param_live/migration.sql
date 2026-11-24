-- B45：字典和参数真正用起来。
-- 新增平台字典"学位类型"，新增两个平台参数（复评窗口天数、每门课最多复评次数）。租户可以为这些参数设自己的值。
INSERT INTO biz."dict_type" ("code", "name", "name_key") VALUES ('degree_type', 'Degree type', 'dict.type.degree_type');
INSERT INTO biz."dict_item" ("type_id", "value", "label", "label_key", "sort")
  SELECT t.id, v.value, v.label, v.label_key, v.sort FROM biz."dict_type" t
  JOIN (VALUES
    ('degree_type', 'associate', 'Associate', 'dict.degree_type.associate', 1),
    ('degree_type', 'bachelor', 'Bachelor', 'dict.degree_type.bachelor', 2),
    ('degree_type', 'master', 'Master', 'dict.degree_type.master', 3),
    ('degree_type', 'doctor', 'Doctor', 'dict.degree_type.doctor', 4)
  ) AS v(code, value, label, label_key, sort) ON v.code = t.code
  WHERE t.tenant_id IS NULL;

INSERT INTO biz."sys_param" ("key", "value", "name", "name_key") VALUES
  ('edu.appeal.windowDays', '14', 'Grade appeal window (days after publication)', 'param.edu.appeal.windowDays'),
  ('edu.appeal.maxPerCourse', '2', 'Maximum grade appeals per course', 'param.edu.appeal.maxPerCourse');
