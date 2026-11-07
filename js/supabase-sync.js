(function () {
  let client = null;

  function sb() {
    if (!client && window.supabase && window.SUPABASE_URL && window.SUPABASE_KEY) {
      client = window.supabase.createClient(window.SUPABASE_URL, window.SUPABASE_KEY);
    }
    return client;
  }

  async function load() {
    const c = sb();
    if (!c) throw new Error('supabase not configured');
    const [p, s] = await Promise.all([
      c.from('products').select('*').order('sort_order', { ascending: true }),
      c.from('site_settings').select('data').eq('id', 'hero').maybeSingle()
    ]);
    if (p.error) throw p.error;
    if (s.error) throw s.error;
    const products = (p.data || []).map((r) => ({
      id: r.id,
      name: r.name,
      description: r.description || '',
      price: Number(r.price),
      category: r.category,
      image: r.image,
      images: (r.images && r.images.length) ? r.images : (r.image ? [r.image] : []),
      visible: r.visible !== false
    }));
    return {
      products,
      hero: s.data ? s.data.data : null,
      hasMeta: !!s.data,
      revision: 'sb',
      updatedAt: 0,
      ids: products.map((x) => x.id),
      hashes: {},
      skipped: []
    };
  }

  async function signIn(email, password) {
    const { data, error } = await sb().auth.signInWithPassword({ email, password });
    if (error) throw error;
    return data.user;
  }

  async function signOut() {
    await sb().auth.signOut();
  }

  async function currentUser() {
    const { data } = await sb().auth.getSession();
    return data.session ? data.session.user : null;
  }

  async function uploadDataUrl(dataUrl, id) {
    if (!/^data:image\//.test(dataUrl || '')) return dataUrl;
    const blob = await (await fetch(dataUrl)).blob();
    const ext = blob.type.includes('webp') ? 'webp' : 'jpg';
    const path = id + '-' + Math.random().toString(36).slice(2, 8) + '.' + ext;
    const { error } = await sb().storage.from('images').upload(path, blob, { contentType: blob.type });
    if (error) throw error;
    return sb().storage.from('images').getPublicUrl(path).data.publicUrl;
  }

  async function publish(list, hero) {
    const c = sb();
    const rows = [];
    for (let i = 0; i < list.length; i++) {
      const p = list[i];
      const images = [];
      for (const im of (p.images || [])) images.push(await uploadDataUrl(im, p.id));
      rows.push({
        id: p.id,
        name: p.name,
        description: p.description,
        price: p.price,
        category: p.category,
        image: images[0] || '',
        images,
        visible: p.visible !== false,
        sort_order: i
      });
    }

    if (rows.length) {
      const r = await c.from('products').upsert(rows);
      if (r.error) throw r.error;
    }

    const existing = await c.from('products').select('id');
    if (existing.error) throw existing.error;
    const keep = rows.map((x) => x.id);
    const gone = existing.data.map((x) => x.id).filter((x) => !keep.includes(x));
    if (gone.length && rows.length) {
      const d = await c.from('products').delete().in('id', gone);
      if (d.error) throw d.error;
    }

    if (hero) {
      const h = { ...hero };
      h.image = await uploadDataUrl(h.image || '', 'hero');
      const r = await c.from('site_settings').upsert({ id: 'hero', data: h });
      if (r.error) throw r.error;
    } else {
      const r = await c.from('site_settings').delete().eq('id', 'hero');
      if (r.error) throw r.error;
    }
    return rows;
  }

  window.SupabaseSync = { load, sb, signIn, signOut, currentUser, publish };
})();
