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
  Cloud.load = async () => {
    const [m, f, g, p] = await Promise.all([
      sb.from("members").select("id,name,color").order("name"),
      sb.from("fonts").select("id,name,category,role,use_case,vn_support,license,created_by,font_files(id,weight,style,file_name,path,size_bytes,sha1)").order("created_at", { ascending: false }),
      sb.from("guidelines").select("*").order("updated_at", { ascending: false }),
      sb.from("projects").select("*").order("done_at", { ascending: false }).limit(500),
    ]);
    for (const r of [m, f, g, p]) if (r.error) fail(r.error, "Không tải được dữ liệu");
    Cloud.members = m.data; Cloud.fontsCache = f.data; Cloud.guidesCache = g.data;
    const memberName = id => m.data.find(x => x.id === id)?.name || "Thành viên";
    return {
      members: m.data,
      fonts: f.data.map(r => ({ ...r, by: memberName(r.created_by), files: (r.font_files || []).sort((a,b) => a.weight - b.weight).map(x => ({ ...x, url: pub("fonts", x.path) })) })),
      guidelines: g.data.map(r => ({ ...r, by: memberName(r.created_by), url: pub("guidelines", r.path), cover: pub("guidelines", r.cover_path) })),
      projects: p.data.map(r => ({ ...r, thumb: pub("thumbs", r.thumb_path) })),
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

  /* ---------- Guideline PDF ---------- */
  // items: [{ file, title, cat, pages, cover (Blob|null) }]
  Cloud.saveGuidelines = async (items) => {
    const out = { added: 0, replaced: 0, errors: [] };
    for (const it of items){
      try {
        const id = uid();
        const up = await sb.storage.from("guidelines").upload(`${id}.pdf`, it.file, { contentType: "application/pdf" });
        if (up.error) fail(up.error, it.file.name);
        let cover_path = null;
        if (it.cover){ const c = await sb.storage.from("guidelines").upload(`covers/${id}.webp`, it.cover, { contentType: "image/webp" }); if (!c.error) cover_path = `covers/${id}.webp`; }
        const row = { title: it.title.trim(), category: it.cat, pages: it.pages || null, size_bytes: it.file.size, file_name: it.file.name, path: `${id}.pdf`, cover_path, updated_at: new Date().toISOString() };
        const existing = Cloud.guidesCache.find(x => x.title.trim().toLowerCase() === row.title.toLowerCase());
        const r = existing ? await sb.from("guidelines").update(row).eq("id", existing.id).select().single()
                           : await sb.from("guidelines").insert(row).select().single();
        if (r.error) fail(r.error, it.title);
        if (existing){ Object.assign(existing, r.data); out.replaced++; } else { Cloud.guidesCache.unshift(r.data); out.added++; }
      } catch(e){ out.errors.push(e.message); }
    }
    return out;
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
