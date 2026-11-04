/** Button classes shared by the brush components and the paint editor's panels. */
export const chip = (on: boolean) => `px-2 py-1 rounded text-[11px] ${on ? 'bg-indigo-600 text-white' : 'bg-slate-800 text-slate-300 hover:text-white'}`;
export const button = 'px-2 py-1 rounded text-[11px] bg-slate-800 text-slate-200 hover:bg-slate-700 disabled:opacity-40';
