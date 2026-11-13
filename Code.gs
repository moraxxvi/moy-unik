/**
 * Мой уник — вся логика здесь (Google Apps Script).
 * Показывает index.html, ходит в Canvas с твоим маркером и шлёт напоминания в Telegram.
 * На компе этот же файл запускает server.js, так что править нужно только его.
 * Маркеры хранятся в личных свойствах скрипта, в коде их нет.
 */
const CANVAS = 'https://canvas.turan-edu.kz';
const API = CANVAS + '/api/v1';
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const TZ_SHIFT = 5 * HOUR; // Алматы: UTC+5 круглый год

function doGet() {
  return HtmlService.createHtmlOutputFromFile('index')
    .setTitle('Мой уник')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

function props_() {
  return PropertiesService.getUserProperties();
}

// ---------- Запросы в Canvas ----------

function request_(url, token) {
  return { url: url, headers: { Authorization: 'Bearer ' + token }, muteHttpExceptions: true };
}

// Разбирает ответ Canvas. Списки приходят страницами — догружаем по ссылке "next".
// must = true для запросов, без которых нельзя (профиль, список курсов): только их отказ значит «маркер плохой».
// Остальные разделы могут быть закрыты или выключены в отдельном курсе — тогда считаем их пустыми.
function readAll_(res, token, must) {
  const all = [];
  for (let page = 0; page < 10; page++) {
    const code = res.getResponseCode();
    if (code === 401 && must) {
      let why = '';
      try { why = JSON.parse(res.getContentText()).errors[0].message; } catch (e) {}
      throw { code: 'token', why: why };
    }
    if (code === 401 || code === 403 || code === 404) return all;
    if (code < 200 || code >= 300) {
      console.error('Canvas ответил ' + code);
      throw { code: 'canvas' };
    }
    const body = JSON.parse(res.getContentText());
    if (!Array.isArray(body)) return body;
    all.push.apply(all, body);
    const headers = res.getHeaders();
    const next = /<([^>]+)>;\s*rel="next"/.exec(String(headers.Link || headers.link || ''));
    if (!next || next[1].indexOf(CANVAS + '/') !== 0) break;
    res = UrlFetchApp.fetch(next[1], request_(next[1], token));
  }
  return all;
}

// Несколько запросов одновременно — так страница открывается быстрее.
function getMany_(paths, token, must) {
  const responses = UrlFetchApp.fetchAll(paths.map(function (p) { return request_(API + p, token); }));
  return responses.map(function (r, i) { return readAll_(r, token, !!must && i < must); });
}

function stripHtml_(html) {
  return String(html || '')
    .replace(/<(style|script)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

function quizInfo_(q) {
  return { aid: q.assignment_id || null, minutes: q.time_limit || null, attempts: q.allowed_attempts || null, questions: q.question_count || null };
}

// ---------- Сбор данных ----------

function loadData_(token) {
  const now = Date.now();
  const to = new Date(now + 60 * DAY).toISOString();

  const first = getMany_([
    '/users/self',
    '/courses?enrollment_state=active&include[]=total_scores&include[]=term&include[]=teachers&include[]=syllabus_body&per_page=100',
    '/planner/items?start_date=' + encodeURIComponent(new Date(now).toISOString()) + '&end_date=' + encodeURIComponent(to) + '&per_page=100',
    '/users/self/activity_stream?per_page=40',
  ], token, 2); // первые два запроса обязательные
  const me = first[0];
  const stream = first[3];

  // Текущий семестр: тот, чьи даты включают сегодня; если дат нет — семестр самого нового курса.
  const real = first[1].filter(function (c) { return c && c.name; });
  const inDates = real.filter(function (c) {
    return c.term && c.term.start_at && new Date(c.term.start_at) <= now && (!c.term.end_at || new Date(c.term.end_at) >= now);
  })[0];
  const newest = real.slice().sort(function (x, y) { return new Date(y.created_at || 0) - new Date(x.created_at || 0); })[0];
  const currentTerm = (inDates || newest || {}).enrollment_term_id;

  const courseNames = {};
  const courses = real.map(function (c) {
    courseNames[c.id] = c.name;
    const e = (c.enrollments || []).filter(function (x) { return x.type === 'student'; })[0] || {};
    const current = c.enrollment_term_id === currentTerm;
    return {
      id: c.id,
      name: c.name,
      url: CANVAS + '/courses/' + c.id + '/grades',
      score: e.computed_current_score == null ? null : e.computed_current_score,
      letter: e.computed_current_grade == null ? null : e.computed_current_grade,
      current: current,
      term: ((c.term && c.term.name) || '').trim(),
      teachers: current ? (c.teachers || []).map(function (t) { return t.display_name; }).filter(Boolean) : [],
      syllabus: current ? stripHtml_(c.syllabus_body).slice(0, 500) : '',
      syllabusUrl: CANVAS + '/courses/' + c.id + '/assignments/syllabus',
      work: [],
    };
  });
  const current = courses.filter(function (c) { return c.current; });

  // По каждому предмету семестра: группы заданий, все работы с оценками и отзывами, тесты. Плюс объявления.
  const paths = [];
  current.forEach(function (c) {
    paths.push('/courses/' + c.id + '/assignment_groups?per_page=100');
    paths.push('/courses/' + c.id + '/students/submissions?student_ids[]=self&include[]=assignment&include[]=submission_comments&per_page=100');
    paths.push('/courses/' + c.id + '/quizzes?per_page=100');
  });
  if (current.length) {
    paths.push('/announcements?' + current.map(function (c) { return 'context_codes[]=course_' + c.id; }).join('&') +
      '&start_date=' + new Date(now - 60 * DAY).toISOString().slice(0, 10) + '&per_page=50');
  }
  const second = paths.length ? getMany_(paths, token) : [];

  const quizById = {};
  const items = [];
  const feed = [];

  current.forEach(function (c, i) {
    const groups = {};
    second[i * 3].forEach(function (g) { groups[g.id] = g.name; });
    const quizByAssignment = {};
    second[i * 3 + 2].forEach(function (q) {
      quizById[q.id] = quizInfo_(q);
      if (q.assignment_id) quizByAssignment[q.assignment_id] = quizInfo_(q);
    });

    second[i * 3 + 1].forEach(function (s) {
      const a = s.assignment;
      if (!a) return;
      // Оценка есть, если стоит балл — даже когда работу пересдали после оценки или тест ждёт ручной проверки.
      // Раньше требовался статус «graded», и такие оценки пропадали.
      const graded = s.score != null;
      const w = {
        id: a.id,
        title: a.name || 'Без названия',
        url: a.html_url || c.url,
        due: a.due_at || null,
        points: a.points_possible == null ? null : a.points_possible,
        score: graded ? s.score : null,
        gradedAt: graded ? s.graded_at || s.posted_at || null : null,
        oldAttempt: graded && s.grade_matches_current_submission === false, // оценка за прошлую попытку, новая ещё не проверена
        submitted: !!s.submitted_at,
        late: !!s.late,
        deducted: s.points_deducted || 0,
        excused: !!s.excused,
        group: groups[a.assignment_group_id] || '',
        omit: !!a.omit_from_final_grade, // не идёт в оценку (посещаемость, СРО)
        quiz: quizByAssignment[a.id] || null,
        comments: (s.submission_comments || [])
          .filter(function (m) { return m.author_id !== me.id && m.comment; })
          .map(function (m) { return { author: m.author_name || '', text: String(m.comment).slice(0, 600), date: m.created_at }; }),
      };
      c.work.push(w);

      // Хвост: срок прошёл, работа не сдана и не оценена.
      if (s.missing && !s.excused && !graded) {
        items.push({
          aid: a.id, title: w.title, course: c.name, date: w.due, url: w.url, type: w.quiz ? 'quiz' : 'assignment',
          points: w.points, needsSubmit: true, done: false, overdue: true, locked: !!a.locked_for_user, quiz: w.quiz,
        });
      }
      // Свежие оценки и отзывы — в ленту «Что нового».
      const lastComment = w.comments.length ? w.comments[w.comments.length - 1] : null;
      const when = [w.gradedAt, lastComment && lastComment.date].filter(Boolean).sort().pop();
      if (when && now - new Date(when) < 14 * DAY && (!w.omit || lastComment)) {
        feed.push({
          kind: w.gradedAt ? 'grade' : 'comment', title: w.title, course: c.name, date: when, url: w.url,
          score: w.score, points: w.points, comment: lastComment ? lastComment.text : '',
        });
      }
    });
    c.work.sort(function (x, y) { return new Date(x.due || 0) - new Date(y.due || 0); });
  });

  // Свежие названия и сроки заданий по номеру — ими поправляем дедлайны из планировщика.
  const fresh = {};
  current.forEach(function (c) { c.work.forEach(function (w) { fresh[w.id] = w; }); });

  // Что предстоит — из планировщика Canvas.
  first[2].forEach(function (p) {
    if (p.plannable_type === 'announcement') return;
    const pl = p.plannable || {};
    const s = p.submissions && typeof p.submissions === 'object' ? p.submissions : null;
    const quiz = p.plannable_type === 'quiz' ? quizById[p.plannable_id] || null : null;
    items.push({
      // номер задания в Canvas — по нему страница связывает дедлайн с оценками и с отметкой «не моё»
      aid: p.plannable_type === 'assignment' ? p.plannable_id : quiz ? quiz.aid : null,
      title: pl.title || pl.name || 'Без названия',
      course: p.context_name || courseNames[p.course_id] || '',
      date: p.plannable_date || pl.due_at || pl.todo_date || null,
      url: p.html_url ? (p.html_url.indexOf('http') === 0 ? p.html_url : CANVAS + p.html_url) : CANVAS,
      type: p.plannable_type,
      points: pl.points_possible == null ? null : pl.points_possible,
      needsSubmit: !!s,
      done: !!(s && (s.submitted || s.graded || s.excused)) || !!(p.planner_override && p.planner_override.marked_complete),
      overdue: false,
      quiz: quiz,
    });
    const last = items[items.length - 1];
    const w = last.aid && fresh[last.aid];
    if (w) { last.title = w.title; if (w.due) last.date = w.due; }
  });

  // Изменения сроков, новые задания и т.п. — из ленты Canvas (оценки уже взяли выше).
  stream.forEach(function (x) {
    if (x.type === 'Submission' || !x.title || !courseNames[x.course_id]) return;
    if (now - new Date(x.updated_at) > 14 * DAY) return;
    feed.push({
      kind: x.type === 'Message' ? 'change' : 'post', title: String(x.title).slice(0, 160), course: courseNames[x.course_id],
      date: x.updated_at, url: x.html_url && x.html_url.indexOf(CANVAS) === 0 ? x.html_url : CANVAS,
    });
  });
  feed.sort(function (a, b) { return new Date(b.date) - new Date(a.date); });

  const announcements = (current.length ? second[second.length - 1] : []).map(function (a) {
    return {
      title: a.title || 'Без названия',
      course: courseNames[String(a.context_code || '').replace('course_', '')] || '',
      date: a.posted_at || a.delayed_post_at || a.created_at || null,
      url: a.html_url && a.html_url.indexOf(CANVAS) === 0 ? a.html_url : CANVAS,
    };
  });

  return {
    name: me.short_name || me.name || '', updated: now,
    courses: courses, items: items, feed: feed.slice(0, 30), announcements: announcements,
  };
}

function fail_(err) {
  if (err && err.code === 'token') return { needToken: true, badToken: true, why: err.why || '' };
  console.error(err && err.message ? err.message : err);
  return { error: err && err.code === 'canvas' ? 'canvas' : 'network' };
}

// ---------- Функции, которые вызывает страница ----------

// Случайный номер аккаунта. Страница хранит последние данные в браузере под этим номером,
// чтобы на общем устройстве другой человек не увидел чужие оценки.
function uid_() {
  const p = props_();
  let id = p.getProperty('UID');
  if (!id) { id = Utilities.getUuid(); p.setProperty('UID', id); }
  return id;
}

function getData() {
  const token = props_().getProperty('CANVAS_TOKEN');
  if (!token) return { needToken: true, uid: uid_() };
  try {
    const data = loadData_(token);
    data.telegram = tgStatus();
    data.settings = readSettings_();
    data.uid = uid_();
    return data;
  } catch (err) {
    const res = fail_(err);
    res.uid = uid_();
    return res;
  }
}

// Настройки страницы: что помечено «не моё», откуда брать экзамен, цели. Хранятся в аккаунте, поэтому одинаковы на компе и телефоне.
function readSettings_() {
  try { return JSON.parse(props_().getProperty('SETTINGS') || '{}'); } catch (e) { return {}; }
}

function saveSettings(settings) {
  const text = JSON.stringify(settings || {});
  if (text.length > 8000) return { error: 'big' };
  props_().setProperty('SETTINGS', text);
  return { ok: true };
}

// Убирает из данных всё, что помечено «не моё» — чтобы напоминания о таком не приходили.
function withoutSkipped_(data) {
  const skip = readSettings_().skip || {};
  data.items = data.items.filter(function (it) { return !skip[it.aid]; });
  return data;
}

function saveToken(token) {
  token = String(token || '').trim();
  if (!token) return { error: 'empty' };
  try {
    readAll_(UrlFetchApp.fetch(API + '/users/self', request_(API + '/users/self', token)), token, true); // проверяем маркер
  } catch (err) {
    return fail_(err);
  }
  props_().setProperty('CANVAS_TOKEN', token);
  return { ok: true };
}

function forgetToken() {
  tgDisconnect();
  props_().deleteProperty('CANVAS_TOKEN');
  return { ok: true };
}

// ---------- Telegram ----------

function tg_(botToken, method, payload) {
  const res = UrlFetchApp.fetch('https://api.telegram.org/bot' + botToken + '/' + method, {
    method: 'post', contentType: 'application/json', payload: JSON.stringify(payload || {}), muteHttpExceptions: true,
  });
  let body = {};
  try { body = JSON.parse(res.getContentText()); } catch (e) {}
  return body;
}

function tgSend_(text) {
  const p = props_();
  const bot = p.getProperty('TG_TOKEN');
  const chat = p.getProperty('TG_CHAT');
  if (!bot || !chat) return false;
  return !!tg_(bot, 'sendMessage', { chat_id: chat, text: text, parse_mode: 'HTML', disable_web_page_preview: true }).ok;
}

function removeTriggers_() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'tgTick') ScriptApp.deleteTrigger(t);
  });
}

function tgStatus() {
  const p = props_();
  return { connected: !!(p.getProperty('TG_TOKEN') && p.getProperty('TG_CHAT')), bot: p.getProperty('TG_BOT') || '' };
}

// Подключение: проверяем маркер бота, находим чат, где ты написал боту, и ставим проверку раз в час.
function tgConnect(botToken) {
  botToken = String(botToken || '').trim();
  const me = tg_(botToken, 'getMe');
  if (!me.ok) return { error: 'badBot' };
  const updates = tg_(botToken, 'getUpdates', { allowed_updates: ['message'] });
  const chats = (updates.result || [])
    .map(function (u) { return u.message && u.message.chat; })
    .filter(function (c) { return c && c.type === 'private'; });
  if (!chats.length) return { error: 'noStart', bot: me.result.username };
  const p = props_();
  p.setProperty('TG_TOKEN', botToken);
  p.setProperty('TG_CHAT', String(chats[chats.length - 1].id));
  p.setProperty('TG_BOT', me.result.username || '');
  p.setProperty('TG_STATE', JSON.stringify({ digestDay: '', alerted: {}, gradesSince: new Date().toISOString() }));
  removeTriggers_();
  ScriptApp.newTrigger('tgTick').timeBased().everyHours(1).create();
  tgSend_('✅ <b>Мой уник подключён.</b>\nБуду писать сюда: утром — сводку дедлайнов, за пару часов до срока — напоминание, и сразу — о новых оценках.');
  return { ok: true, bot: me.result.username };
}

function tgDisconnect() {
  const p = props_();
  ['TG_TOKEN', 'TG_CHAT', 'TG_BOT', 'TG_STATE'].forEach(function (k) { p.deleteProperty(k); });
  removeTriggers_();
  return { ok: true };
}

function tgTest() {
  const token = props_().getProperty('CANVAS_TOKEN');
  if (!token) return { error: 'noToken' };
  try {
    return { ok: tgSend_(digest_(withoutSkipped_(loadData_(token)), Date.now()) || 'На ближайшую неделю дедлайнов нет.') };
  } catch (err) {
    return fail_(err);
  }
}

function h_(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function local_(ms) { return new Date(ms + TZ_SHIFT); }           // «алматинские» часы читаем через getUTC*
function dayKey_(ms) { return local_(ms).toISOString().slice(0, 10); }
function time_(iso) {
  const d = local_(new Date(iso).getTime());
  return ('0' + d.getUTCHours()).slice(-2) + ':' + ('0' + d.getUTCMinutes()).slice(-2);
}
function date_(iso) {
  const d = local_(new Date(iso).getTime());
  return d.getUTCDate() + '.' + ('0' + (d.getUTCMonth() + 1)).slice(-2);
}
function line_(it, withDate) {
  return '• <a href="' + h_(it.url) + '">' + h_(it.title) + '</a> — ' + h_(it.course) + ', ' + (withDate ? date_(it.date) + ' ' : '') + time_(it.date);
}

// Утренняя сводка. Пустая строка — если писать не о чем.
function digest_(data, now) {
  const todo = data.items.filter(function (it) { return it.date && !it.done && it.needsSubmit; })
    .sort(function (a, b) { return new Date(a.date) - new Date(b.date); });
  const today = dayKey_(now);
  const tomorrow = dayKey_(now + DAY);
  const overdue = todo.filter(function (it) { return it.overdue; });
  const future = todo.filter(function (it) { return !it.overdue && new Date(it.date) > now; });
  const dToday = future.filter(function (it) { return dayKey_(new Date(it.date).getTime()) === today; });
  const dTomorrow = future.filter(function (it) { return dayKey_(new Date(it.date).getTime()) === tomorrow; });
  const week = future.filter(function (it) { return new Date(it.date) - now <= 7 * DAY; });
  if (!overdue.length && !week.length) return '';
  const parts = ['<b>Мой уник — сводка</b>'];
  if (overdue.length) parts.push('🔴 <b>Просрочено: ' + overdue.length + '</b>\n' + overdue.slice(0, 8).map(function (it) { return line_(it, true); }).join('\n'));
  if (dToday.length) parts.push('🟠 <b>Сегодня</b>\n' + dToday.map(function (it) { return line_(it, false); }).join('\n'));
  if (dTomorrow.length) parts.push('🟡 <b>Завтра</b>\n' + dTomorrow.map(function (it) { return line_(it, false); }).join('\n'));
  const later = week.filter(function (it) { return dToday.indexOf(it) < 0 && dTomorrow.indexOf(it) < 0; });
  if (later.length) parts.push('<b>В ближайшие 7 дней</b>\n' + later.slice(0, 10).map(function (it) { return line_(it, true); }).join('\n'));
  return parts.join('\n\n');
}

// Запускается раз в час сам (триггер ставит tgConnect).
function tgTick() {
  const p = props_();
  const token = p.getProperty('CANVAS_TOKEN');
  if (!token || !p.getProperty('TG_TOKEN')) return;
  const now = Date.now();
  let state = {};
  try { state = JSON.parse(p.getProperty('TG_STATE') || '{}'); } catch (e) {}
  state.alerted = state.alerted || {};
  const data = withoutSkipped_(loadData_(token));

  // 1. Утренняя сводка — один раз в день после 8:00.
  if (local_(now).getUTCHours() >= 8 && state.digestDay !== dayKey_(now)) {
    const text = digest_(data, now);
    if (text) tgSend_(text);
    state.digestDay = dayKey_(now);
  }

  // 2. Напоминание, когда до срока осталось меньше 3 часов.
  data.items.forEach(function (it) {
    if (!it.date || it.done || !it.needsSubmit || it.overdue) return;
    const left = new Date(it.date) - now;
    const key = it.url + '|' + it.date;
    if (left <= 0 || left > 3 * HOUR || state.alerted[key]) return;
    const hours = Math.floor(left / HOUR);
    const mins = Math.round((left % HOUR) / 60000);
    tgSend_('⏰ <b>Осталось ' + (hours ? hours + ' ч ' : '') + mins + ' мин</b>\n<a href="' + h_(it.url) + '">' + h_(it.title) + '</a>\n' + h_(it.course) + ' · до ' + time_(it.date));
    state.alerted[key] = now;
  });
  Object.keys(state.alerted).forEach(function (k) { if (now - state.alerted[k] > 3 * DAY) delete state.alerted[k]; });

  // 3. Новые оценки (посещаемость и прочее, что не идёт в оценку, пропускаем).
  const since = state.gradesSince || new Date(now).toISOString();
  data.courses.forEach(function (c) {
    c.work.forEach(function (w) {
      if (w.omit || !w.gradedAt || w.gradedAt <= since) return;
      const comment = w.comments.length ? '\n💬 ' + h_(w.comments[w.comments.length - 1].text) : '';
      tgSend_('📝 <b>Новая оценка: ' + h_(w.score) + (w.points != null ? ' из ' + h_(w.points) : '') + '</b>\n<a href="' + h_(w.url) + '">' + h_(w.title) + '</a>\n' + h_(c.name) + comment);
    });
  });
  state.gradesSince = new Date(now).toISOString();

  p.setProperty('TG_STATE', JSON.stringify(state));
}
