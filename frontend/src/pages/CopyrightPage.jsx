import React from 'react';
import { Link } from 'react-router';
import { ArrowLeft, Shield } from 'lucide-react';
import logo from '../assets/logo.png';

export default function CopyrightPage() {
  const year = new Date().getFullYear();
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
            <Shield className="w-5 h-5 text-primary-600" />
          </div>
          <div>
            <h1 className="text-2xl font-bold text-slate-900">Copyright Notice</h1>
            <p className="text-slate-500 text-sm">Intellectual Property Information</p>
          </div>
        </div>

        <div className="bg-white rounded-2xl border border-slate-100 shadow-sm p-8 space-y-6 text-sm leading-relaxed text-slate-700">
          <div className="text-center py-6 border-b border-slate-100">
            <img src={logo} alt="Youthnic" className="w-16 h-16 object-contain mx-auto mb-4" />
            <p className="text-2xl font-bold text-slate-900">Â© {year} Youthnic Exports Pvt. Ltd.</p>
            <p className="text-slate-500 mt-1">All Rights Reserved</p>
          </div>

          <div>
            <h3 className="font-bold text-slate-900 text-[14px] mb-2">Software Copyright</h3>
            <p className="text-slate-600">The Youthnic Packing Station software, including all source code, design, user interface, features, and functionality, is the exclusive intellectual property of Youthnic Exports Pvt. Ltd. and is protected by copyright laws of India and international treaties.</p>
          </div>
          <div>
            <h3 className="font-bold text-slate-900 text-[14px] mb-2">Trademark</h3>
            <p className="text-slate-600">"Youthnic" and the Youthnic logo are registered trademarks of Youthnic Exports Pvt. Ltd. Unauthorized use of these trademarks is strictly prohibited.</p>
          </div>
          <div>
            <h3 className="font-bold text-slate-900 text-[14px] mb-2">Permitted Use</h3>
            <p className="text-slate-600">This software is licensed, not sold. Authorized users may use the software solely for internal business operations of Youthnic Exports Pvt. Ltd. Any reproduction, modification, or distribution without explicit written consent is prohibited.</p>
          </div>
          <div>
            <h3 className="font-bold text-slate-900 text-[14px] mb-2">Third-Party Libraries</h3>
            <p className="text-slate-600">This software uses open-source libraries including open-source frontend, server, authentication, and styling libraries, each governed by their respective licenses (MIT, Apache 2.0). Full attribution is maintained in the project's package.json files.</p>
          </div>
          <div>
            <h3 className="font-bold text-slate-900 text-[14px] mb-2">Reporting Violations</h3>
            <p className="text-slate-600">To report copyright infringement, contact <a href="mailto:legal@youthnic.shop" className="text-primary-600 hover:underline">legal@youthnic.shop</a></p>
          </div>

          <div className="bg-primary-50 border border-primary-100 rounded-xl p-4 text-primary-700 text-xs">
            <strong>Version:</strong> Youthnic Packing Station v2.0 Â· Built {year}
          </div>
        </div>
      </div>
    </div>
  );
}
