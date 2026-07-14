import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowLeft, Mail, Phone, Building2, Clock, Send, MessageSquare, CheckCircle2 } from 'lucide-react';
import logo from '../assets/logo.png';

export default function ContactDetails() {
  const [form, setForm]     = useState({ name: '', email: '', subject: '', message: '' });
  const [sent, setSent]     = useState(false);
  const [sending, setSending] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setSending(true);
    // Simulate send (wire to MailerSend if needed)
    await new Promise(r => setTimeout(r, 1200));
    setSent(true);
    setSending(false);
  };

  return (
    <div className="min-h-screen bg-[#f8fafc]">
      <header className="bg-white/80 backdrop-blur border-b border-slate-200 px-6 py-4 flex items-center gap-4 sticky top-0 z-10">
        <Link to="/" className="flex items-center gap-2 text-slate-500 hover:text-slate-800 transition-colors">
          <ArrowLeft className="w-4 h-4" /><span className="text-sm font-medium">Back</span>
        </Link>
        <div className="w-px h-5 bg-slate-200" />
        <div className="flex items-center gap-2">
          <img src={logo} alt="Youthnic" className="w-7 h-7 object-contain" />
          <span className="font-bold text-slate-900 text-sm">Youthnic Packing Station</span>
        </div>
      </header>

      <div className="max-w-5xl mx-auto px-6 py-12">
        <div className="flex items-center gap-3 mb-8">
          <div className="w-10 h-10 bg-primary-100 rounded-xl flex items-center justify-center">
            <MessageSquare className="w-5 h-5 text-primary-600" />
          </div>
          <div>
            <h1 className="text-2xl font-bold text-slate-900">Contact Us</h1>
            <p className="text-slate-500 text-sm">Get in touch with the Youthnic team</p>
          </div>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-5 gap-6">
          {/* Info cards */}
          <div className="lg:col-span-2 space-y-4">
            {[
              { icon: Building2, label: 'Company',  value: 'Youthnic Exports Pvt. Ltd.',   sub: 'New Delhi, India' },
              { icon: Mail,      label: 'Email',    value: 'support@youthnic.shop',         sub: 'For technical support' },
              { icon: Mail,      label: 'Admin',    value: 'returnorders@vbexports.co.in',  sub: 'Operations & dispatch' },
              { icon: Phone,     label: 'Phone',    value: '+91 — (on request)',             sub: 'Business hours only' },
              { icon: Clock,     label: 'Hours',    value: 'Mon–Sat, 9AM–7PM IST',          sub: 'Closed on national holidays' },
            ].map(item => (
              <div key={item.label} className="bg-white rounded-xl border border-slate-100 shadow-sm p-4 flex items-start gap-3">
                <div className="w-8 h-8 bg-primary-50 rounded-lg flex items-center justify-center flex-shrink-0">
                  <item.icon className="w-4 h-4 text-primary-600" />
                </div>
                <div>
                  <p className="text-[10px] font-semibold uppercase tracking-wider text-slate-400 mb-0.5">{item.label}</p>
                  <p className="text-[13px] font-semibold text-slate-900">{item.value}</p>
                  <p className="text-[11px] text-slate-400">{item.sub}</p>
                </div>
              </div>
            ))}
          </div>

          {/* Contact form */}
          <div className="lg:col-span-3 bg-white rounded-2xl border border-slate-100 shadow-sm p-6">
            {sent ? (
              <div className="flex flex-col items-center justify-center h-full py-12 text-center">
                <div className="w-16 h-16 bg-emerald-100 rounded-full flex items-center justify-center mb-4">
                  <CheckCircle2 className="w-8 h-8 text-emerald-600" />
                </div>
                <h3 className="text-lg font-bold text-slate-900 mb-2">Message Sent!</h3>
                <p className="text-slate-500 text-sm">We'll get back to you within 1–2 business days.</p>
                <button onClick={() => { setSent(false); setForm({ name:'',email:'',subject:'',message:'' }); }}
                  className="mt-6 btn btn-ghost text-sm">Send Another</button>
              </div>
            ) : (
              <>
                <h2 className="text-lg font-bold text-slate-900 mb-5">Send us a message</h2>
                <form onSubmit={handleSubmit} className="space-y-4">
                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <label className="block text-xs font-semibold text-slate-600 mb-1.5">Your Name *</label>
                      <input required value={form.name} onChange={e => setForm({...form,name:e.target.value})} className="inp" placeholder="Full name" />
                    </div>
                    <div>
                      <label className="block text-xs font-semibold text-slate-600 mb-1.5">Email *</label>
                      <input required type="email" value={form.email} onChange={e => setForm({...form,email:e.target.value})} className="inp" placeholder="you@example.com" />
                    </div>
                  </div>
                  <div>
                    <label className="block text-xs font-semibold text-slate-600 mb-1.5">Subject *</label>
                    <input required value={form.subject} onChange={e => setForm({...form,subject:e.target.value})} className="inp" placeholder="Brief description of your query" />
                  </div>
                  <div>
                    <label className="block text-xs font-semibold text-slate-600 mb-1.5">Message *</label>
                    <textarea required rows={5} value={form.message} onChange={e => setForm({...form,message:e.target.value})} className="inp resize-none" placeholder="Describe your issue or question in detail..." />
                  </div>
                  <button type="submit" disabled={sending} className="btn btn-primary w-full justify-center">
                    {sending ? <div className="w-4 h-4 border-2 border-white/40 border-t-white rounded-full animate-spin" /> : <Send className="w-4 h-4" />}
                    {sending ? 'Sending…' : 'Send Message'}
                  </button>
                </form>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
