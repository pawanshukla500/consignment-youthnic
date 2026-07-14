import React from 'react';
import { Link } from 'react-router-dom';
import { ArrowLeft, Lock } from 'lucide-react';
import logo from '../assets/logo.png';
const S = ({title,body}) => (<div><h3 className="font-bold text-slate-900 text-[14px] mb-2">{title}</h3><p className="text-slate-600">{body}</p></div>);
export default function PrivacyPolicy() {
  return (
    <div className="min-h-screen bg-[#f8fafc]">
      <header className="bg-white/80 backdrop-blur border-b border-slate-200 px-6 py-4 flex items-center gap-4 sticky top-0 z-10">
        <Link to="/" className="flex items-center gap-2 text-slate-500 hover:text-slate-800 transition-colors"><ArrowLeft className="w-4 h-4"/><span className="text-sm font-medium">Back</span></Link>
        <div className="w-px h-5 bg-slate-200"/>
        <div className="flex items-center gap-2"><img src={logo} alt="Youthnic" className="w-7 h-7 object-contain"/><span className="font-bold text-slate-900 text-sm">Youthnic Packing Station</span></div>
      </header>
      <div className="max-w-3xl mx-auto px-6 py-12">
        <div className="flex items-center gap-3 mb-8">
          <div className="w-10 h-10 bg-primary-100 rounded-xl flex items-center justify-center"><Lock className="w-5 h-5 text-primary-600"/></div>
          <div><h1 className="text-2xl font-bold text-slate-900">Privacy Policy</h1><p className="text-slate-500 text-sm">Last updated: June 2025</p></div>
        </div>
        <div className="bg-white rounded-2xl border border-slate-100 shadow-sm p-8 space-y-6 text-sm leading-relaxed">
          <S title="1. Information We Collect" body="We collect information you provide when creating consignments, scanning SKUs, uploading documents, and using the packing station. This includes shipment numbers, product barcodes, quantities, dates, and user actions. We also collect system usage logs and CCTV/packing video recordings."/>
          <S title="2. How We Use Information" body="Data is used exclusively for: managing consignment packing workflows, generating reports, ensuring quality control through video verification, audit trails for accountability, and system performance monitoring."/>
          <S title="3. Data Storage" body="All data is stored on our secure cloud environment servers. Data is encrypted at rest and in transit. Video recordings are stored in protected file storage with configurable retention periods (default: 60 days after inward date)."/>
          <S title="4. Data Access" body="Access to data is role-based. Only authorized employees with valid credentials can access the system. Admin users can access all data. Regular users can only access data permitted by their assigned role."/>
          <S title="5. Data Retention" body="Consignment data is retained for 450 days by default. Videos are retained for 60 days after the consignment Date of Inward. Audit logs are retained indefinitely. Retention periods can be configured by system administrators."/>
          <S title="6. Data Sharing" body="We do not sell, trade, or share your data with third parties except: (a) our secure cloud service providers, (b) MailerSend for email notifications, (c) as required by law or legal proceedings."/>
          <S title="7. Video Recording" body="Packing station video recordings are used solely for quality control and dispute resolution. Videos are automatically deleted per the retention schedule unless a Marketplace Ticket ID is present, which protects them from deletion."/>
          <S title="8. Security" body="We implement industry-standard security: signed sessions with expiry, HTTPS encryption, cloud security policies, and role-based access controls. Passwords are protected using one-way hashing."/>
          <S title="9. Your Rights" body="Authorized personnel may request access to, correction of, or deletion of their personal data by contacting the system administrator. Account deletion requests will be processed within 7 business days."/>
          <S title="10. Contact" body="For privacy-related concerns, contact our Data Protection Officer at privacy@youthnic.shop or returnorders@vbexports.co.in."/>
          <div className="border-t border-slate-100 pt-6 text-xs text-slate-400">This policy applies to the internal Youthnic Packing Station software only.</div>
        </div>
      </div>
    </div>
  );
}
