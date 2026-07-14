import React, { useState, useEffect, useCallback } from 'react';
import { Truck, Plus, Search, Trash2, Loader2, Edit2 } from 'lucide-react';
import { docketCompaniesAPI } from '../services/api';
import { useToast } from '../context/ToastContext';
import { useDebounce } from '../hooks/useDebounce';
import Modal from '../components/Modal';
import ConfirmModal from '../components/ConfirmModal';

export default function DocketCompanies() {
  const { addToast } = useToast();
  const [companies, setCompanies] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [showFormModal, setShowFormModal] = useState(false);
  const [showDelete, setShowDelete] = useState(false);
  const [selected, setSelected] = useState(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [form, setForm] = useState({ name: '', officialName: '', gst: '' });
  const [formErrors, setFormErrors] = useState({});
  const debouncedSearch = useDebounce(search, 400);

  const validateForm = () => {
    const errors = {};
    if (!form.name.trim()) errors.name = 'Docket Company Name is required';
    setFormErrors(errors);
    return Object.keys(errors).length === 0;
  };

  const fetchData = useCallback(async () => {
    try {
      setLoading(true);
      const res = await docketCompaniesAPI.getAll();
      let data = res.data.companies || [];
      if (debouncedSearch) {
        const s = debouncedSearch.toLowerCase();
        data = data.filter(
          (m) =>
            m.name?.toLowerCase().includes(s) ||
            m.officialName?.toLowerCase().includes(s) ||
            m.gst?.toLowerCase().includes(s)
        );
      }
      setCompanies(data);
    } catch (error) {
      addToast('Failed to load docket companies', 'error');
    } finally {
      setLoading(false);
    }
  }, [debouncedSearch, addToast]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!validateForm()) return;
    setIsSubmitting(true);
    try {
      const payload = {
        name: form.name.trim(),
        officialName: form.officialName.trim(),
        gst: form.gst.trim(),
      };
      if (selected) {
        await docketCompaniesAPI.update(selected.id, payload);
        addToast('Docket company updated', 'success');
      } else {
        await docketCompaniesAPI.create(payload);
        addToast('Docket company created', 'success');
      }
      setShowFormModal(false);
      setSelected(null);
      setForm({ name: '', officialName: '', gst: '' });
      fetchData();
    } catch (error) {
      addToast(error.response?.data?.error || 'Failed to save docket company', 'error');
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleDelete = async () => {
    if (!selected) return;
    setIsSubmitting(true);
    try {
      await docketCompaniesAPI.delete(selected.id);
      addToast('Docket company deleted', 'success');
      setShowDelete(false);
      setSelected(null);
      fetchData();
    } catch (error) {
      addToast('Failed to delete docket company', 'error');
    } finally {
      setIsSubmitting(false);
    }
  };

  const openCreate = () => {
    setSelected(null);
    setForm({ name: '', officialName: '', gst: '' });
    setFormErrors({});
    setShowFormModal(true);
  };

  const openEdit = (m) => {
    setSelected(m);
    setForm({
      name: m.name || '',
      officialName: m.officialName || '',
      gst: m.gst || '',
    });
    setFormErrors({});
    setShowFormModal(true);
  };

  return (
    <div className="animate-fade-in">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between mb-8 gap-4">
        <div>
          <h1 className="text-3xl font-bold text-slate-900">Docket Companies</h1>
          <p className="text-slate-500 mt-1">Manage logistics and courier partners</p>
        </div>
        <button
          onClick={openCreate}
          className="flex items-center gap-2 px-4 py-2.5 bg-primary-600 text-white rounded-lg hover:bg-primary-700 text-sm font-semibold shadow-sm transition-colors"
        >
          <Plus className="w-4 h-4" />
          New Docket Company
        </button>
      </div>

      <div className="bg-white rounded-xl shadow-sm border border-slate-100 p-4 mb-6">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-slate-400" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search companies by name, official name, or GST..."
            className="w-full pl-10 pr-4 py-2.5 border border-slate-200 rounded-lg focus:ring-2 focus:ring-primary-500 outline-none"
          />
        </div>
      </div>

      <div className="bg-white rounded-xl shadow-sm border border-slate-100 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead className="bg-slate-50">
              <tr>
                <th className="text-left text-xs font-semibold text-slate-500 uppercase px-6 py-4">Docket Company</th>
                <th className="text-left text-xs font-semibold text-slate-500 uppercase px-6 py-4">GST Number</th>
                <th className="text-right text-xs font-semibold text-slate-500 uppercase px-6 py-4 w-32">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {loading ? (
                <tr>
                  <td colSpan="3" className="py-12 text-center">
                    <Loader2 className="w-8 h-8 animate-spin mx-auto text-primary-600" />
                  </td>
                </tr>
              ) : companies.length > 0 ? (
                companies.map((m) => (
                  <tr key={m.id} className="hover:bg-slate-50/80 align-top">
                    <td className="px-6 py-4">
                      <div className="flex items-start gap-3">
                        <div className="p-2.5 bg-primary-50 rounded-xl shrink-0 mt-0.5">
                          <Truck className="w-4 h-4 text-primary-600" />
                        </div>
                        <div className="min-w-0">
                          <p className="text-sm font-semibold text-slate-900 truncate">{m.name}</p>
                          {m.officialName && (
                            <p className="text-xs text-slate-500 mt-1 font-medium bg-slate-50 border border-slate-100 px-1.5 py-0.5 rounded w-fit">
                              Official: {m.officialName}
                            </p>
                          )}
                        </div>
                      </div>
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap">
                      {m.gst ? (
                        <span className="text-xs font-mono font-bold text-slate-700 bg-slate-100 border border-slate-200 px-2 py-0.5 rounded">
                          {m.gst}
                        </span>
                      ) : (
                        <span className="text-xs text-slate-400">—</span>
                      )}
                    </td>
                    <td className="px-6 py-4">
                      <div className="flex items-center justify-end gap-1">
                        <button
                          type="button"
                          onClick={() => openEdit(m)}
                          className="p-2 text-slate-400 hover:text-primary-600 hover:bg-primary-50 rounded-lg transition-colors"
                          title="Edit"
                        >
                          <Edit2 className="w-4 h-4" />
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            setSelected(m);
                            setShowDelete(true);
                          }}
                          className="p-2 text-slate-400 hover:text-red-600 hover:bg-red-50 rounded-lg transition-colors"
                          title="Delete"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))
              ) : (
                <tr>
                  <td colSpan="3" className="py-12 text-center text-slate-400">
                    <Truck className="w-12 h-12 mx-auto mb-3 text-slate-300" />
                    <p>No companies found</p>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Create / Edit Modal */}
      <Modal
        open={showFormModal}
        onClose={() => !isSubmitting && (setShowFormModal(false), setSelected(null))}
        title={selected ? 'Edit Docket Company' : 'New Docket Company'}
        subtitle="Configure logistics/courier partner billing details and GST settings"
        size="md"
        footer={
          <div className="flex flex-col-reverse sm:flex-row sm:justify-end gap-2">
            <button
              type="button"
              onClick={() => {
                setShowFormModal(false);
                setSelected(null);
              }}
              className="px-5 py-2.5 border border-slate-200 rounded-lg text-slate-700 hover:bg-slate-50"
              disabled={isSubmitting}
            >
              Cancel
            </button>
            <button
              type="submit"
              form="docket-company-form"
              disabled={isSubmitting}
              className="px-5 py-2.5 bg-primary-600 text-white rounded-lg hover:bg-primary-700 disabled:opacity-50 flex items-center justify-center gap-2 font-medium"
            >
              {isSubmitting && <Loader2 className="w-4 h-4 animate-spin" />}
              {selected ? 'Save Changes' : 'Create Company'}
            </button>
          </div>
        }
      >
        <form id="docket-company-form" onSubmit={handleSubmit} className="p-5 sm:p-6 space-y-4">
          <div>
            <label className="block text-sm font-semibold text-slate-700 mb-2">
              Docket Company Name <span className="text-red-500">*</span>
            </label>
            <input
              type="text"
              value={form.name}
              onChange={(e) => {
                setForm({ ...form, name: e.target.value });
                setFormErrors((p) => ({ ...p, name: '' }));
              }}
              className={`w-full px-4 py-2.5 border rounded-xl text-sm focus:ring-2 focus:ring-primary-500 outline-none ${
                formErrors.name ? 'border-red-300 bg-red-50/50' : 'border-slate-200'
              }`}
              placeholder="e.g. Delhivery, BlueDart, Professional"
              autoFocus
            />
            {formErrors.name && <p className="text-xs text-red-600 mt-1.5">{formErrors.name}</p>}
          </div>

          <div>
            <label className="block text-sm font-semibold text-slate-700 mb-2">Official Company Name</label>
            <input
              type="text"
              value={form.officialName}
              onChange={(e) => setForm({ ...form, officialName: e.target.value })}
              className="w-full px-4 py-2.5 border border-slate-200 rounded-xl text-sm focus:ring-2 focus:ring-primary-500 outline-none"
              placeholder="e.g. Delhivery Limited, Blue Dart Express Limited"
            />
          </div>

          <div>
            <label className="block text-sm font-semibold text-slate-700 mb-2">GST Number</label>
            <input
              type="text"
              value={form.gst}
              onChange={(e) => setForm({ ...form, gst: e.target.value.toUpperCase() })}
              className="w-full px-4 py-2.5 border border-slate-200 rounded-xl text-sm focus:ring-2 focus:ring-primary-500 outline-none font-mono text-slate-800"
              placeholder="e.g. 07AAAAA1111A1Z1"
            />
          </div>
        </form>
      </Modal>

      {/* Delete Modal */}
      <ConfirmModal
        show={showDelete}
        onCancel={() => !isSubmitting && setShowDelete(false)}
        onConfirm={handleDelete}
        title="Delete Docket Company"
        message={selected ? `Delete "${selected.name}"? This cannot be undone.` : ''}
        confirmLabel="Delete"
        variant="danger"
        loading={isSubmitting}
      />
    </div>
  );
}
