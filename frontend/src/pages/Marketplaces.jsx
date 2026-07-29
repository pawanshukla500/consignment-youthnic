import React, { useState, useEffect, useCallback, useRef } from 'react';
import { Store, Plus, Search, Trash2, Loader2, Edit2, X, Check, Warehouse, Truck, RefreshCw } from 'lucide-react';
import { marketplacesAPI } from '../services/api';
import { useToast } from '../context/ToastContext';
import { useDebounce } from '../hooks/useDebounce';
import Modal from '../components/Modal';
import ConfirmModal from '../components/ConfirmModal';
import { normalizeWarehouses, computeRequiredDispatchDate } from '../utils/dispatchPlanning';
import { formatDispatchDate } from '../utils/priority';

const emptyWarehouse = () => ({ name: '', transitDays: 0, address: '', state: '', gst: '' });

function WarehouseEditor({ warehouses, onChange, disabled }) {
  const [draft, setDraft] = useState(emptyWarehouse());

  const add = () => {
    const name = draft.name.trim();
    if (!name) return;
    if (warehouses.some((w) => w.name.toLowerCase() === name.toLowerCase())) return;
    onChange([...warehouses, {
      name,
      transitDays: Math.max(0, parseInt(draft.transitDays, 10) || 0),
      address: draft.address.trim(),
      state: draft.state.trim(),
      gst: draft.gst.trim(),
    }]);
    setDraft(emptyWarehouse());
  };

  const updateField = (idx, field, value) => {
    const next = warehouses.map((w, i) =>
      i === idx ? { ...w, [field]: value } : w
    );
    onChange(next);
  };

  const remove = (idx) => onChange(warehouses.filter((_, i) => i !== idx));

  return (
    <div className="space-y-3 border border-slate-100 rounded-lg p-3 bg-slate-50/60">
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
        <div className="sm:col-span-2">
          <label className="block text-[10px] font-bold uppercase tracking-wider text-slate-400 mb-1">Warehouse</label>
          <input
            type="text"
            value={draft.name}
            onChange={(e) => setDraft({ ...draft, name: e.target.value })}
            disabled={disabled}
            placeholder="e.g. Bangalore"
            className="w-full px-2.5 py-1.5 border border-slate-200 bg-white rounded-md text-xs focus:ring-2 focus:ring-primary-500 outline-none disabled:bg-slate-50"
          />
        </div>
        <div>
          <label className="block text-[10px] font-bold uppercase tracking-wider text-slate-400 mb-1">Transit days</label>
          <input
            type="number"
            min="0"
            value={draft.transitDays}
            onChange={(e) => setDraft({ ...draft, transitDays: e.target.value })}
            disabled={disabled}
            className="w-full px-2.5 py-1.5 border border-slate-200 bg-white rounded-md text-xs focus:ring-2 focus:ring-primary-500 outline-none disabled:bg-slate-50"
          />
        </div>
        <div>
          <label className="block text-[10px] font-bold uppercase tracking-wider text-slate-400 mb-1">State</label>
          <input
            type="text"
            value={draft.state}
            onChange={(e) => setDraft({ ...draft, state: e.target.value })}
            disabled={disabled}
            placeholder="e.g. Karnataka"
            className="w-full px-2.5 py-1.5 border border-slate-200 bg-white rounded-md text-xs focus:ring-2 focus:ring-primary-500 outline-none disabled:bg-slate-50"
          />
        </div>
        <div className="sm:col-span-2">
          <label className="block text-[10px] font-bold uppercase tracking-wider text-slate-400 mb-1">GST</label>
          <input
            type="text"
            value={draft.gst}
            onChange={(e) => setDraft({ ...draft, gst: e.target.value })}
            disabled={disabled}
            placeholder="optional"
            className="w-full px-2.5 py-1.5 border border-slate-200 bg-white rounded-md text-xs focus:ring-2 focus:ring-primary-500 outline-none disabled:bg-slate-50"
          />
        </div>
        <div className="sm:col-span-2">
          <label className="block text-[10px] font-bold uppercase tracking-wider text-slate-400 mb-1">Address</label>
          <input
            type="text"
            value={draft.address}
            onChange={(e) => setDraft({ ...draft, address: e.target.value })}
            disabled={disabled}
            placeholder="Street / area / city"
            className="w-full px-2.5 py-1.5 border border-slate-200 bg-white rounded-md text-xs focus:ring-2 focus:ring-primary-500 outline-none disabled:bg-slate-50"
          />
        </div>
      </div>
      <div className="flex justify-end">
        <button
          type="button"
          onClick={add}
          disabled={disabled || !draft.name.trim()}
          className="px-3 py-1.5 bg-primary-600 hover:bg-primary-700 disabled:opacity-50 text-white rounded-md text-xs font-semibold inline-flex items-center gap-1"
        >
          <Plus className="w-3.5 h-3.5" /> Add
        </button>
      </div>

      {warehouses.length > 0 && (
        <div className="space-y-2 pt-2 border-t border-slate-100 max-h-64 overflow-y-auto">
          {warehouses.map((w, idx) => (
            <div key={`${w.name}-${idx}`} className="bg-white border border-slate-200 rounded-lg p-2.5">
              <div className="flex items-center justify-between gap-2 mb-2">
                <div className="flex items-center gap-1.5 min-w-0">
                  <Warehouse className="w-3.5 h-3.5 text-primary-600 shrink-0" />
                  <span className="font-semibold text-slate-900 text-xs truncate">{w.name}</span>
                  {w.state ? (
                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-slate-100 text-slate-600 shrink-0">{w.state}</span>
                  ) : null}
                </div>
                {!disabled && (
                  <button type="button" onClick={() => remove(idx)} className="p-1 text-slate-400 hover:text-red-600 rounded">
                    <X className="w-3.5 h-3.5" />
                  </button>
                )}
              </div>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs">
                <label className="block">
                  <span className="text-[9px] uppercase font-semibold text-slate-400">Transit</span>
                  <div className="flex items-center gap-1 mt-0.5">
                    <input
                      type="number"
                      min="0"
                      value={w.transitDays}
                      onChange={(e) => updateField(idx, 'transitDays', Math.max(0, parseInt(e.target.value, 10) || 0))}
                      disabled={disabled}
                      className="w-14 px-1.5 py-0.5 border border-slate-200 rounded text-center font-semibold"
                    />
                    <span className="text-slate-500">d</span>
                  </div>
                </label>
                <label className="block">
                  <span className="text-[9px] uppercase font-semibold text-slate-400">State</span>
                  <input
                    type="text"
                    value={w.state || ''}
                    onChange={(e) => updateField(idx, 'state', e.target.value)}
                    disabled={disabled}
                    placeholder="State"
                    className="w-full mt-0.5 px-1.5 py-0.5 border border-slate-200 rounded"
                  />
                </label>
                <label className="block sm:col-span-2">
                  <span className="text-[9px] uppercase font-semibold text-slate-400">GST</span>
                  <input
                    type="text"
                    value={w.gst || ''}
                    onChange={(e) => updateField(idx, 'gst', e.target.value)}
                    disabled={disabled}
                    placeholder="None"
                    className="w-full mt-0.5 px-1.5 py-0.5 border border-slate-200 rounded"
                  />
                </label>
                <label className="block col-span-2 sm:col-span-4">
                  <span className="text-[9px] uppercase font-semibold text-slate-400">Address</span>
                  <input
                    type="text"
                    value={w.address || ''}
                    onChange={(e) => updateField(idx, 'address', e.target.value)}
                    disabled={disabled}
                    placeholder="Address details"
                    className="w-full mt-0.5 px-1.5 py-0.5 border border-slate-200 rounded"
                  />
                </label>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export default function Marketplaces() {
  const { addToast } = useToast();
  const [marketplaces, setMarketplaces] = useState([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [search, setSearch] = useState('');
  const [showCreate, setShowCreate] = useState(false);
  const [showDelete, setShowDelete] = useState(false);
  const [selected, setSelected] = useState(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [editing, setEditing] = useState(null);
  const [editForm, setEditForm] = useState({ name: '', billTo: '', warehouses: [] });
  const debouncedSearch = useDebounce(search, 400);
  const didInitialLoad = useRef(false);

  const [formErrors, setFormErrors] = useState({});

  const validateForm = () => {
    const errors = {};
    if (!form.name.trim()) errors.name = 'Marketplace name is required';
    if (!form.billTo.trim()) errors.billTo = 'Bill To details are required';
    if (form.warehouses.length === 0) errors.warehouses = 'Add at least one warehouse';
    if (form.warehouses.some((w) => !w.name.trim())) errors.warehouses = 'All warehouses need a name';
    const badGst = form.warehouses.find((w) => {
      const gst = String(w.gst || '').trim()
      if (!gst) return false
      return !/^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/i.test(gst)
    })
    if (badGst) errors.warehouses = `Invalid GSTIN on warehouse "${badGst.name}"`
    const badState = form.warehouses.find((w) => String(w.state || '').trim().length > 48)
    if (badState) errors.warehouses = `State too long on warehouse "${badState.name}"`
    setFormErrors(errors);
    return Object.keys(errors).length === 0;
  };

  const [form, setForm] = useState({ name: '', billTo: '', warehouses: [] });

  const resetCreateForm = () => {
    setForm({ name: '', billTo: '', warehouses: [] });
    setFormErrors({});
  };

  const openCreate = () => {
    resetCreateForm();
    setShowCreate(true);
  };

  const fetchData = useCallback(async ({ silent = false } = {}) => {
    try {
      if (silent) setRefreshing(true);
      else setLoading(true);
      const res = await marketplacesAPI.getAll();
      let data = (res.data.marketplaces || []).map((m) => ({
        ...m,
        warehouses: normalizeWarehouses(m.warehouses),
      }));
      if (debouncedSearch) {
        const s = debouncedSearch.toLowerCase();
        data = data.filter(
          (m) =>
            m.name?.toLowerCase().includes(s) ||
            m.warehouses?.some((w) => w.name.toLowerCase().includes(s))
        );
      }
      setMarketplaces(data);
    } catch {
      addToast('Failed to load marketplaces', 'error');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [debouncedSearch, addToast]);

  useEffect(() => {
    fetchData({ silent: didInitialLoad.current });
    didInitialLoad.current = true;
  }, [fetchData]);

  const stats = {
    total: marketplaces.length,
    warehouses: marketplaces.reduce((n, m) => n + (m.warehouses?.length || 0), 0),
    withTransit: marketplaces.reduce(
      (n, m) => n + (m.warehouses || []).filter((w) => w.transitDays > 0).length,
      0
    ),
  };

  const handleCreate = async (e) => {
    e.preventDefault();
    if (!validateForm()) return;
    setIsSubmitting(true);
    try {
      await marketplacesAPI.create({ name: form.name.trim(), billTo: form.billTo.trim(), warehouses: form.warehouses });
      addToast('Marketplace created', 'success');
      setShowCreate(false);
      resetCreateForm();
      fetchData({ silent: true });
    } catch (error) {
      addToast(error.response?.data?.error || 'Failed to create', 'error');
    }
    setIsSubmitting(false);
  };

  const handleDelete = async () => {
    if (!selected) return;
    setIsSubmitting(true);
    try {
      await marketplacesAPI.delete(selected.id);
      addToast('Marketplace deleted', 'success');
      setShowDelete(false);
      setSelected(null);
      fetchData({ silent: true });
    } catch (error) {
      addToast(error.response?.data?.error || 'Failed to delete', 'error');
    }
    setIsSubmitting(false);
  };

  const startEdit = (m) => {
    setEditing(m.id);
    setEditForm({ name: m.name, billTo: m.billTo || '', warehouses: normalizeWarehouses(m.warehouses) });
  };

  const cancelEdit = () => {
    setEditing(null);
    setEditForm({ name: '', billTo: '', warehouses: [] });
  };

  const saveEdit = async (id) => {
    if (!editForm.name.trim()) return;
    const badGst = (editForm.warehouses || []).find((w) => {
      const gst = String(w.gst || '').trim()
      if (!gst) return false
      return !/^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/i.test(gst)
    })
    if (badGst) {
      addToast(`Invalid GSTIN on warehouse "${badGst.name}"`, 'error')
      return
    }
    setIsSubmitting(true);
    try {
      await marketplacesAPI.update(id, { name: editForm.name.trim(), billTo: editForm.billTo.trim(), warehouses: editForm.warehouses });
      addToast('Marketplace updated', 'success');
      setEditing(null);
      fetchData({ silent: true });
    } catch (error) {
      addToast(error.response?.data?.error || 'Failed to update', 'error');
    }
    setIsSubmitting(false);
  };

  return (
    <div className="animate-fade-in">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-4">
        <div className="flex items-center gap-2 text-sm text-slate-500">
          {refreshing && <RefreshCw className="w-4 h-4 animate-spin text-primary-500" />}
          <span>{loading ? 'Loading…' : `${marketplaces.length} marketplace${marketplaces.length !== 1 ? 's' : ''} · ${stats.warehouses} warehouses`}</span>
        </div>
        <button
          type="button"
          onClick={openCreate}
          className="inline-flex items-center gap-2 px-3.5 py-2 bg-primary-600 text-white rounded-lg hover:bg-primary-700 text-sm font-medium"
        >
          <Plus className="w-4 h-4" />
          New Marketplace
        </button>
      </div>

      <p className="text-xs text-slate-500 mb-3">
        Transit days drive required dispatch (appointment − transit). Keep warehouse state filled for billing clarity.
      </p>

      <div className="mb-4">
        <div className="relative max-w-md">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search marketplaces or warehouses..."
            className="w-full pl-9 pr-3 py-2 border border-slate-200 rounded-lg text-sm focus:ring-2 focus:ring-primary-500 outline-none"
          />
        </div>
      </div>

      <div className="bg-white rounded-xl border border-slate-100 overflow-hidden relative">
        {refreshing && (
          <div className="absolute inset-x-0 top-0 h-0.5 bg-primary-100 overflow-hidden z-20">
            <div className="h-full w-1/3 bg-primary-500 animate-pulse" />
          </div>
        )}
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead className="bg-slate-50">
              <tr>
                <th className="text-left text-[10px] font-semibold text-slate-500 uppercase px-4 py-2.5 w-[28%]">Marketplace</th>
                <th className="text-left text-[10px] font-semibold text-slate-500 uppercase px-4 py-2.5">Warehouses &amp; transit</th>
                <th className="text-right text-[10px] font-semibold text-slate-500 uppercase px-4 py-2.5 w-24">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {loading ? (
                <tr>
                  <td colSpan="3" className="py-10 text-center">
                    <Loader2 className="w-7 h-7 animate-spin mx-auto text-primary-600" />
                  </td>
                </tr>
              ) : marketplaces.length > 0 ? (
                marketplaces.map((m) => (
                  <tr key={m.id} className="hover:bg-slate-50/80 align-top">
                    <td className="px-4 py-3">
                      {editing === m.id ? (
                        <div className="space-y-2">
                          <div>
                            <label className="block text-[9px] uppercase font-bold text-slate-400 mb-0.5">Panel name</label>
                            <input
                              value={editForm.name}
                              onChange={(e) => setEditForm({ ...editForm, name: e.target.value })}
                              className="w-full px-2 py-1.5 border border-slate-200 rounded-md text-xs focus:ring-2 focus:ring-primary-500 outline-none"
                              placeholder="Panel name"
                              autoFocus
                            />
                          </div>
                          <div>
                            <label className="block text-[9px] uppercase font-bold text-slate-400 mb-0.5">Bill to</label>
                            <input
                              value={editForm.billTo}
                              onChange={(e) => setEditForm({ ...editForm, billTo: e.target.value })}
                              className="w-full px-2 py-1.5 border border-slate-200 rounded-md text-xs focus:ring-2 focus:ring-primary-500 outline-none"
                              placeholder="Billing name"
                            />
                          </div>
                        </div>
                      ) : (
                        <div>
                          <p className="text-sm font-semibold text-slate-900">{m.name}</p>
                          {m.billTo && (
                            <p className="text-[11px] text-slate-500 mt-0.5">Bill to: {m.billTo}</p>
                          )}
                          <p className="text-[10px] text-slate-400 mt-1">{m.warehouses?.length || 0} warehouse(s)</p>
                        </div>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      {editing === m.id ? (
                        <WarehouseEditor
                          warehouses={editForm.warehouses}
                          onChange={(warehouses) => setEditForm({ ...editForm, warehouses })}
                        />
                      ) : m.warehouses?.length > 0 ? (
                        <div className="flex flex-wrap gap-1.5">
                          {m.warehouses.map((w) => (
                            <div
                              key={w.name}
                              className="inline-flex flex-col gap-0.5 rounded-md border border-slate-200 bg-slate-50 px-2 py-1.5 text-[11px] min-w-[9rem] max-w-[16rem]"
                              title={[w.state, w.address, w.gst].filter(Boolean).join(' · ')}
                            >
                              <span className="font-semibold text-slate-800 inline-flex items-center gap-1">
                                <Warehouse className="w-3 h-3 text-primary-600" />
                                {w.name}
                              </span>
                              <span className="text-slate-500 inline-flex items-center gap-1">
                                <Truck className="w-3 h-3" />
                                {w.transitDays}d
                                {w.state ? <> · {w.state}</> : null}
                              </span>
                            </div>
                          ))}
                        </div>
                      ) : (
                        <span className="text-xs text-slate-400">No warehouses</span>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center justify-end gap-1">
                        {editing === m.id ? (
                          <>
                            <button
                              type="button"
                              onClick={() => saveEdit(m.id)}
                              disabled={isSubmitting}
                              className="p-1.5 text-emerald-600 hover:bg-emerald-50 rounded-md"
                              title="Save"
                            >
                              <Check className="w-4 h-4" />
                            </button>
                            <button type="button" onClick={cancelEdit} className="p-1.5 text-slate-400 hover:bg-slate-100 rounded-md" title="Cancel">
                              <X className="w-4 h-4" />
                            </button>
                          </>
                        ) : (
                          <>
                            <button
                              type="button"
                              onClick={() => startEdit(m)}
                              className="p-1.5 text-slate-400 hover:text-primary-600 hover:bg-primary-50 rounded-md"
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
                              className="p-1.5 text-slate-400 hover:text-red-600 hover:bg-red-50 rounded-md"
                              title="Delete"
                            >
                              <Trash2 className="w-4 h-4" />
                            </button>
                          </>
                        )}
                      </div>
                    </td>
                  </tr>
                ))
              ) : (
                <tr>
                  <td colSpan="3" className="py-10 text-center text-slate-400">
                    <Store className="w-10 h-10 mx-auto mb-2 text-slate-300" />
                    <p className="text-sm">No marketplaces found</p>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      <Modal
        open={showCreate}
        onClose={() => !isSubmitting && (setShowCreate(false), resetCreateForm())}
        title="New Marketplace"
        subtitle="Portal name + warehouse transit for dispatch planning"
        size="lg"
        footer={
          <div className="flex flex-col-reverse sm:flex-row sm:justify-end gap-2">
            <button
              type="button"
              onClick={() => { setShowCreate(false); resetCreateForm(); }}
              className="px-5 py-2.5 border border-slate-200 rounded-lg text-slate-700 hover:bg-slate-50"
              disabled={isSubmitting}
            >
              Cancel
            </button>
            <button
              type="submit"
              form="create-marketplace-form"
              disabled={isSubmitting}
              className="px-5 py-2.5 bg-primary-600 text-white rounded-lg hover:bg-primary-700 disabled:opacity-50 flex items-center justify-center gap-2 font-medium"
            >
              {isSubmitting && <Loader2 className="w-4 h-4 animate-spin" />}
              Create Marketplace
            </button>
          </div>
        }
      >
        <form id="create-marketplace-form" onSubmit={handleCreate} className="p-5 sm:p-6 space-y-6">
          <div className="rounded-xl bg-gradient-to-br from-primary-50 to-primary-50 border border-primary-100 p-4 flex gap-3">
            <div className="p-2 bg-white rounded-lg shadow-sm h-fit">
              <Store className="w-5 h-5 text-primary-600" />
            </div>
            <div className="text-sm text-slate-700">
              <p className="font-semibold text-slate-900">Dispatch planning</p>
              <p className="mt-1 text-slate-600">
                Required dispatch = appointment date − transit days.
                Example: 5-day transit with appointment <strong>10 Jul</strong> → pack and dispatch by <strong>5 Jul</strong>.
              </p>
            </div>
          </div>

          <div>
            <label className="block text-sm font-semibold text-slate-700 mb-2">
              Panel Name <span className="text-red-500">*</span>
            </label>
            <input
              type="text"
              value={form.name}
              onChange={(e) => { setForm({ ...form, name: e.target.value }); setFormErrors((p) => ({ ...p, name: '' })); }}
              className={`w-full px-4 py-3 border rounded-xl text-sm focus:ring-2 focus:ring-primary-500 outline-none ${
                formErrors.name ? 'border-red-300 bg-red-50/50' : 'border-slate-200'
              }`}
              placeholder="e.g. Amazon India, Flipkart, Myntra"
              autoFocus
            />
            {formErrors.name && <p className="text-xs text-red-600 mt-1.5">{formErrors.name}</p>}
          </div>

          <div>
            <label className="block text-sm font-semibold text-slate-700 mb-2">
              Bill To <span className="text-red-500">*</span>
            </label>
            <textarea
              value={form.billTo}
              onChange={(e) => { setForm({ ...form, billTo: e.target.value }); setFormErrors((p) => ({ ...p, billTo: '' })); }}
              className={`w-full px-4 py-3 border rounded-xl text-sm focus:ring-2 focus:ring-primary-500 outline-none ${
                formErrors.billTo ? 'border-red-300 bg-red-50/50' : 'border-slate-200'
              }`}
              placeholder="Enter billing legal entity name and complete registered office address details..."
              rows="3"
            />
            {formErrors.billTo && <p className="text-xs text-red-600 mt-1.5">{formErrors.billTo}</p>}
          </div>

          <div>
            <div className="flex items-center justify-between mb-2">
              <label className="block text-sm font-semibold text-slate-700">
                Warehouses &amp; in-transit days <span className="text-red-500">*</span>
              </label>
              <span className="text-xs text-slate-400">{form.warehouses.length} configured</span>
            </div>
            <WarehouseEditor
              warehouses={form.warehouses}
              onChange={(warehouses) => { setForm({ ...form, warehouses }); setFormErrors((p) => ({ ...p, warehouses: '' })); }}
            />
            {formErrors.warehouses && <p className="text-xs text-red-600 mt-1.5">{formErrors.warehouses}</p>}
          </div>

          {form.warehouses.length > 0 && (
            <div className="rounded-xl border border-slate-200 bg-slate-50 p-4">
              <p className="text-xs font-semibold uppercase tracking-wider text-slate-500 mb-3">Preview — dispatch deadline</p>
              <div className="space-y-2">
                {form.warehouses.map((w) => {
                  const sampleAppt = '2026-07-10';
                  const dispatch = computeRequiredDispatchDate(sampleAppt, w.transitDays);
                  return (
                    <div key={w.name} className="flex flex-wrap items-center gap-2 text-sm">
                      <span className="font-medium text-slate-800">{w.name}</span>
                      <span className="text-slate-400">·</span>
                      <span className="text-slate-600">{w.transitDays || 0}d transit</span>
                      <span className="text-slate-400">→</span>
                      <span className="text-primary-700 font-medium">
                        Dispatch by {dispatch ? formatDispatchDate(dispatch) : '—'} (if appt. 10 Jul)
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </form>
      </Modal>

      <ConfirmModal
        show={showDelete}
        onCancel={() => !isSubmitting && setShowDelete(false)}
        onConfirm={handleDelete}
        title="Delete Marketplace"
        message={selected ? `Delete "${selected.name}"? This cannot be undone. Marketplaces linked to consignments cannot be deleted.` : ''}
        confirmLabel="Delete"
        variant="danger"
        loading={isSubmitting}
      />
    </div>
  );
}
