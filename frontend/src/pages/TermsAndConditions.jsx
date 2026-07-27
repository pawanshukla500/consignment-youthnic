import React from 'react';
import { Link } from 'react-router';
import { ArrowLeft, FileText } from 'lucide-react';
import logo from '../assets/logo.png';

const Section = ({ title, body }) => (
  <div>
    <h3 className="font-bold text-slate-900 text-[14px] mb-2">{title}</h3>
    <p className="text-slate-600">{body}</p>
  </div>
);

export default function TermsAndConditions() {
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
      <div className="max-w-3xl mx-auto px-6 py-12">
        <div className="flex items-center gap-3 mb-8">
          <div className="w-10 h-10 bg-primary-100 rounded-xl flex items-center justify-center">
            <FileText className="w-5 h-5 text-primary-600" />
          </div>
          <div>
            <h1 className="text-2xl font-bold text-slate-900">Terms & Conditions</h1>
            <p className="text-slate-500 text-sm">Last updated: June 2025</p>
          </div>
        </div>
        <div className="bg-white rounded-2xl border border-slate-100 shadow-sm p-8 space-y-6 text-sm leading-relaxed">
          <Section title="1. Acceptance of Terms" body="By accessing and using the Youthnic Packing Station system, you agree to be bound by these Terms and Conditions. If you do not agree, you may not use the System." />
          <Section title="2. Authorized Use" body="This System is exclusively for use by authorized employees and contractors of Youthnic Exports Pvt. Ltd. Unauthorized access is strictly prohibited and may result in legal action." />
          <Section title="3. User Accounts" body="Each user is responsible for maintaining the confidentiality of their login credentials. Passwords must not be shared. The Admin is solely responsible for creating and managing user accounts and permissions." />
          <Section title="4. Data & Privacy" body="All data including consignment details, SKU information, and packing videos is the property of Youthnic Exports Pvt. Ltd. Data is stored securely in our protected cloud environment and governed by our Privacy Policy." />
          <Section title="5. CCTV & Video Recording" body="The System includes CCTV/video recording for packing verification. All recordings are stored securely and used solely for quality control and dispute resolution. Users operating packing stations consent to video recording of the packing area." />
          <Section title="6. Prohibited Actions" body="Users must not: attempt to bypass authentication, extract data without authorization, use the system for non-business purposes, introduce malicious code, or misuse admin privileges." />
          <Section title="7. Intellectual Property" body="All software, designs, and content within this System are proprietary to Youthnic Exports Pvt. Ltd. Copying, distributing, or reverse-engineering any part of this System is strictly prohibited." />
          <Section title="8. Limitation of Liability" body="Youthnic Exports Pvt. Ltd. shall not be liable for any indirect, incidental, or consequential damages arising from the use of this System. The System is provided 'as is' without warranties of any kind." />
          <Section title="9. Changes to Terms" body="We reserve the right to modify these terms at any time. Continued use of the System after changes constitutes acceptance of the updated terms." />
          <Section title="10. Governing Law" body="These Terms are governed by the laws of India. Any disputes shall be subject to the exclusive jurisdiction of courts in New Delhi, India." />
          <div className="border-t border-slate-100 pt-6 text-xs text-slate-400">
            For questions about these Terms, contact <a href="mailto:legal@youthnic.shop" className="text-primary-600 hover:underline">legal@youthnic.shop</a>
          </div>
        </div>
      </div>
      <footer className="border-t border-slate-200 px-6 py-4 flex items-center justify-center gap-4 text-xs text-slate-400">
        <Link to="/privacy" className="hover:text-primary-600">Privacy Policy</Link>
        <span>Â·</span>
        <Link to="/contact" className="hover:text-primary-600">Contact Us</Link>
        <span>Â·</span>
        <Link to="/copyright" className="hover:text-primary-600">Copyright</Link>
        <span>Â·</span>
        <span>Â© 2025 Youthnic Exports Pvt. Ltd.</span>
      </footer>
    </div>
  );
}
