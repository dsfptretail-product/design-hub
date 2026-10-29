/* Design Hub · lớp kết nối Supabase
   Bật khi config.js có SUPABASE_URL + SUPABASE_ANON_KEY. Không có thì hub chạy chế độ demo (lưu tạm trong trình duyệt). */
(function(){
  const CFG = window.HUB_CONFIG || {};
  const on = !!(CFG.SUPABASE_URL && CFG.SUPABASE_ANON_KEY && window.supabase);
  const Cloud = { on, session: null, user: null, member: null, members: [], fontsCache: [], guidesCache: [] };
  window.Cloud = Cloud;
  if (!on) return;

  const sb = window.supabase.createClient(CFG.SUPABASE_URL, CFG.SUPABASE_ANON_KEY, { auth: { persistSession: true, detectSessionInUrl: true } });
  Cloud.sb = sb;
  const pub = (bucket, path) => path ? sb.storage.from(bucket).getPublicUrl(path).data.publicUrl : null;
  Cloud.url = pub;
  const dl = (bucket, path) => path ? sb.storage.from(bucket).getPublicUrl(path, { download: path.split("/").pop() }).data.publicUrl : null;
  const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));
  const fail = (err, what) => { const e = new Error((what ? what + ": " : "") + (err?.message || err)); e.code = err?.code || err?.statusCode; throw e; };

  /* ---------- Auth ---------- */
  Cloud.init = async (onChange) => {
    const { data } = await sb.auth.getSession();
    Cloud.session = data.session; Cloud.user = data.session?.user || null;
    if (Cloud.user) await Cloud.ensureMember();
    sb.auth.onAuthStateChange(async (_evt, session) => {
      const was = Cloud.user?.id;
      Cloud.session = session; Cloud.user = session?.user || null;
      if (Cloud.user && Cloud.user.id !== was) await Cloud.ensureMember();
      if (!Cloud.user) Cloud.member = null;
      if ((Cloud.user?.id) !== was) onChange && onChange();
    });
  };
  Cloud.signIn = async (email) => {
    const { error } = await sb.auth.signInWithOtp({ email, options: { shouldCreateUser: !!CFG.ALLOW_SIGNUP, emailRedirectTo: location.origin + location.pathname } });
    if (error) fail(error);
  };
  Cloud.signInPassword = async (email, password) => {
    const { error } = await sb.auth.signInWithPassword({ email, password });
    if (error) fail(error);
  };
  Cloud.changePassword = async (password) => {
    const { error } = await sb.auth.updateUser({ password });
    if (error) fail(error);
  };
  Cloud.signOut = () => sb.auth.signOut();
  Cloud.ensureMember = async () => {
    const id = Cloud.user.id;
    let { data } = await sb.from("members").select("*").eq("id", id).maybeSingle();
    if (!data){
      const name = (Cloud.user.email || "Thành viên").split("@")[0].replace(/[._-]+/g, " ").replace(/\b\w/g, c => c.toUpperCase());
      const colors = ["#CB1C22","#034EA2","#2F855A","#F37021","#444B52","#901418","#1250DC"];
      const res = await sb.from("members").insert({ id, name, color: colors[Math.floor(Math.random()*colors.length)] }).select().single();
      data = res.data;
    }
    Cloud.member = data;
  };
  Cloud.rename = async (name) => {
    const { data, error } = await sb.from("members").update({ name }).eq("id", Cloud.user.id).select().single();
    if (error) fail(error); Cloud.member = data;
  };

  /* ---------- Đọc dữ liệu ---------- */
  // bảng mới (migration 003): thiếu bảng thì coi như rỗng và nhắc chạy migration
  const soft = async q => { const r = await q; if (r.error && /does not exist|schema cache|42P01|PGRST20|column/i.test((r.error.message || "") + (r.error.code || ""))){ Cloud.needsMigration = true; return { data: [] }; } return r; };
  Cloud.load = async () => {
    Cloud.needsMigration = false;
    const [m, f, g, p, t, ms, h] = await Promise.all([
      sb.from("members").select("id,name,color").order("name"),
      sb.from("fonts").select("id,name,category,role,use_case,vn_support,license,created_by,font_files(id,weight,style,file_name,path,size_bytes,sha1)").order("created_at", { ascending: false }),
      sb.from("guidelines").select("*, guideline_versions(*)").order("updated_at", { ascending: false }),
      sb.from("projects").select("*").order("done_at", { ascending: false }).limit(3000),
      soft(sb.from("templates").select("*").order("updated_at", { ascending: false })),
      soft(sb.from("mascots").select("*").order("created_at", { ascending: true })),
      soft(sb.from("hidden_items").select("kind,key")),
    ]);
    for (const r of [m, f, g, p, t, ms, h]) if (r.error) fail(r.error, "Không tải được dữ liệu");
    if (p.data[0] && !("pinned" in p.data[0])) Cloud.needsMigration = true;
    Cloud.members = m.data; Cloud.fontsCache = f.data; Cloud.guidesCache = g.data;
    const memberName = id => m.data.find(x => x.id === id)?.name || "Thành viên";
    return {
      members: m.data,
      fonts: f.data.map(r => ({ ...r, by: memberName(r.created_by), files: (r.font_files || []).sort((a,b) => a.weight - b.weight).map(x => ({ ...x, url: pub("fonts", x.path) })) })),
      guidelines: g.data.map(r => ({ ...r, by: memberName(r.created_by), url: pub("guidelines", r.path), cover: pub("guidelines", r.cover_path), versions: (r.guideline_versions || []).sort((a,b) => b.created_at.localeCompare(a.created_at)).map(v => ({ ...v, by: memberName(v.created_by) })) })),
      projects: p.data.map(r => ({ ...r, thumb: pub("thumbs", r.thumb_path) })),
      templates: t.data.map(r => ({ ...r, by: memberName(r.updated_by || r.created_by), thumb: pub("thumbs", r.thumb_path) })),
      mascots: ms.data.map(r => ({ ...r, by: memberName(r.created_by), img: pub("mascots", r.thumb_path), img3: pub("mascots", r.thumb3d_path),
        pngUrl: dl("mascots", r.png_path), aiUrl: dl("mascots", r.ai_path), url3: dl("mascots", r.render3d_path) })),
      hidden: h.data,
    };
  };

  /* ---------- Font ---------- */
  const FONT_MIME = { ttf: "font/ttf", otf: "font/otf", woff: "font/woff", woff2: "font/woff2" };
  // groups: [{ name, cat, use, vn, files: [{ file, weight, style, hash }] }]
  Cloud.saveFonts = async (groups) => {
    const out = { added: 0, extended: 0, skipped: 0, errors: [] };
    for (const g of groups){
      try {
        let font = Cloud.fontsCache.find(x => x.name.trim().toLowerCase() === g.name.trim().toLowerCase());
        if (!font){
          const r = await sb.from("fonts").insert({ name: g.name.trim(), category: g.cat, use_case: g.use, vn_support: g.vn, role: "Tải lên bởi " + (Cloud.member?.name || "team") }).select().single();
          if (r.error) fail(r.error, g.name);
          font = r.data; Cloud.fontsCache.unshift(font); out.added++;
        } else out.extended++;
        for (const f of g.files){
          const ext = (f.file.name.split(".").pop() || "ttf").toLowerCase();
          const path = `${font.id}/${f.hash}.${ext}`;
          const up = await sb.storage.from("fonts").upload(path, f.file, { contentType: FONT_MIME[ext] || "application/octet-stream", upsert: false });
          if (up.error && !/exists|duplicate/i.test(up.error.message)) fail(up.error, f.file.name);
          const ins = await sb.from("font_files").insert({ font_id: font.id, weight: f.weight, style: f.style, file_name: f.file.name, path, size_bytes: f.file.size, sha1: f.hash });
          if (ins.error){ if (ins.error.code === "23505") out.skipped++; else fail(ins.error, f.file.name); }
        }
      } catch(e){ out.errors.push(e.message); }
    }
    return out;
  };

  /* ---------- Guideline: link Google Drive + phiên bản ---------- */
  // g: tài liệu hiện có (có thể là bản dựng sẵn chưa nằm trong DB) hoặc null; info: {title, cat, desc}; ver: {v, note, drive:{id, kind}}
  Cloud.addGuideVersion = async (g, info, ver) => {
    let gid = g?.cloudId;
    if (!gid){
      const row = { title: (info?.title || g.title).trim(), category: info?.cat || g.cat, description: (info?.desc ?? g?.desc) || null, updated_at: new Date().toISOString() };
      const ex = Cloud.guidesCache.find(x => x.title.trim().toLowerCase() === row.title.toLowerCase());
      if (ex) gid = ex.id;
      else {
        const r = await sb.from("guidelines").insert(row).select().single();
        if (r.error) fail(r.error, row.title);
        gid = r.data.id; Cloud.guidesCache.unshift(r.data);
        // tài liệu dựng sẵn trên Drive: giữ lại các bản cũ trong lịch sử
        const old = (g?.versions || []).filter(v => v.drive).slice().reverse();
        for (const v of old){
          const o = await sb.from("guideline_versions").insert({ guideline_id: gid, version: v.v, drive_id: v.drive.id, kind: v.drive.kind, note: v.note || null, created_at: new Date(v.date).toISOString() });
          if (o.error) fail(o.error, "Lịch sử cũ");
        }
      }
    }
    const r = await sb.from("guideline_versions").insert({ guideline_id: gid, version: ver.v, drive_id: ver.drive.id, kind: ver.drive.kind, note: ver.note || null });
    if (r.error) fail(r.error, "Phiên bản mới");
    const patch = { updated_at: new Date().toISOString() };
    if (info){ patch.category = info.cat; if (info.desc) patch.description = info.desc; }
    const u = await sb.from("guidelines").update(patch).eq("id", gid);
    if (u.error) fail(u.error, "Cập nhật tài liệu");
  };
  Cloud.updateGuideline = async (g, info) => {
    if (!g.cloudId){
      // tài liệu dựng sẵn: tạo bản ghi rồi chép lịch sử Drive hiện có
      const r = await sb.from("guidelines").insert({ title: info.title, category: info.cat, description: info.desc || null }).select().single();
      if (r.error) fail(r.error, info.title);
      for (const v of (g.versions || []).filter(v => v.drive).slice().reverse()){
        const o = await sb.from("guideline_versions").insert({ guideline_id: r.data.id, version: v.v, drive_id: v.drive.id, kind: v.drive.kind, note: v.note || null, created_at: new Date(v.date).toISOString() });
        if (o.error) fail(o.error, "Lịch sử cũ");
      }
      return;
    }
    const r = await sb.from("guidelines").update({ title: info.title, category: info.cat, description: info.desc || null, updated_at: new Date().toISOString() }).eq("id", g.cloudId);
    if (r.error) fail(r.error, info.title);
  };

  /* ---------- Xoá / ẩn ---------- */
  Cloud.del = async (table, id, files) => {
    const r = await sb.from(table).delete().eq("id", id).select("id");
    if (r.error) fail(r.error);
    if (!r.data?.length) fail("Không có quyền xoá mục này. Quản trị viên cần chạy migration-003 trong Supabase.");
    const byBucket = {};
    (files || []).forEach(([b, path]) => path && (byBucket[b] = byBucket[b] || []).push(path));
    for (const [b, paths] of Object.entries(byBucket)) await sb.storage.from(b).remove(paths).catch(() => {});
  };
  Cloud.hide = async (kind, key) => {
    const r = await sb.from("hidden_items").upsert({ kind, key }, { onConflict: "kind,key", ignoreDuplicates: true });
    if (r.error) fail(r.error, "Ẩn mục có sẵn");
  };

  /* ---------- Template ---------- */
  Cloud.saveTemplate = async (info, thumbBlob, id) => {
    let thumb_path;
    if (thumbBlob){ const path = `tpl-${uid()}.webp`; const u = await sb.storage.from("thumbs").upload(path, thumbBlob, { contentType: "image/webp" }); if (u.error) fail(u.error, "Ảnh thumbnail"); thumb_path = path; }
    const row = { title: info.title, category: info.cat, description: info.desc || null, link: info.link, tool: info.tool, sizes: info.size || null, tags: info.tags, updated_at: new Date().toISOString(), updated_by: Cloud.user.id };
    if (thumb_path) row.thumb_path = thumb_path;
    const r = id ? await sb.from("templates").update(row).eq("id", id).select("id") : await sb.from("templates").insert(row).select("id");
    if (r.error) fail(r.error, info.title);
    if (!r.data?.length) fail("Không có quyền sửa template này.");
  };

  /* ---------- Mascot ---------- */
  Cloud.saveMascot = async (info, f) => {
    const dir = uid(), done = [];
    const put = async (name, file, type) => {
      if (!file) return null;
      const path = `${dir}/${name}`;
      const u = await sb.storage.from("mascots").upload(path, file, { contentType: type || file.type || "application/octet-stream", upsert: false });
      if (u.error){ if (done.length) await sb.storage.from("mascots").remove(done).catch(() => {}); fail(u.error, name); }
      done.push(path); return path;
    };
    const ext = (f.ai.name.split(".").pop() || "ai").toLowerCase();
    const row = {
      name: info.name, grp: info.group, use_case: info.use || null,
      png_path: await put(`${info.name.replace(/[\/]/g, "-")}.png`, f.png, "image/png"),
      ai_path: await put(`${info.name.replace(/[\/]/g, "-")}.${ext}`, f.ai, ext === "pdf" ? "application/pdf" : ext === "svg" ? "image/svg+xml" : "application/postscript"),
      thumb_path: await put("thumb.webp", f.thumb, "image/webp"),
      render3d_path: await put(`${info.name.replace(/[\/]/g, "-")}-3d.${(f.r3d?.name.split(".").pop() || "png").toLowerCase()}`, f.r3d),
      thumb3d_path: await put("thumb-3d.webp", f.thumb3, "image/webp"),
    };
    const r = await sb.from("mascots").insert(row);
    if (r.error){ await sb.storage.from("mascots").remove(done).catch(() => {}); fail(r.error, info.name); }
  };

  /* ---------- Task: ghim + nhập CSV ---------- */
  Cloud.setPinned = async (id, pinned) => {
    const r = await sb.from("projects").update({ pinned }).eq("id", id).select("id");
    if (r.error) fail(r.error); if (!r.data?.length) fail("Không có quyền ghim. Quản trị viên cần chạy migration-003.");
  };
  Cloud.importProjects = async (list) => {
    const rows = list.map(x => ({ external_id: x.code, code: x.code, source: "jira", title: x.title, type: x.type, people: x.people, tags: x.tags, link: x.link || null, done_at: x.date, status: x.status || null }));
    for (let i = 0; i < rows.length; i += 200){
      const r = await sb.from("projects").upsert(rows.slice(i, i + 200), { onConflict: "external_id" });
      if (r.error) fail(r.error, "Nhập CSV");
    }
  };

  /* ---------- Task ---------- */
  Cloud.saveProject = async (p, thumbBlob) => {
    let thumb_path = null;
    if (thumbBlob){ const path = `${uid()}.webp`; const r = await sb.storage.from("thumbs").upload(path, thumbBlob, { contentType: "image/webp" }); if (r.error) fail(r.error, "Ảnh thumbnail"); thumb_path = path; }
    const r = await sb.from("projects").insert({ title: p.title, type: p.type, people: p.people, tags: p.tags, link: p.link || null, thumb_path, done_at: p.date }).select().single();
    if (r.error) fail(r.error, p.title);
    return { ...r.data, thumb: pub("thumbs", thumb_path) };
  };
})();
