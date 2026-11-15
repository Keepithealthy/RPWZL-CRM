import '../test/autocleanup';
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { MultiSelect } from './MultiSelect';

const opts = Array.from({ length: 10 }, (_, i) => ({ value: `v${i}`, label: i === 3 ? 'Łódzkie' : `Opcja ${i}`, count: i * 1000 }));

describe('MultiSelect', () => {
  it('shows counts with Polish grouping and toggles values', () => {
    const onChange = vi.fn();
    render(<MultiSelect title="Test" options={opts} selected={['v1']} onChange={onChange} defaultOpen />);
    expect(screen.getByText((t) => t.replace(/\s/g, '') === '9000')).toBeTruthy();
    fireEvent.click(screen.getByLabelText(/Opcja 2/));
    expect(onChange).toHaveBeenCalledWith(['v1', 'v2']);
    fireEvent.click(screen.getByLabelText(/Opcja 1/));
    expect(onChange).toHaveBeenLastCalledWith([]);
  });

  it('searches without diacritics, then selects all visible, clears and inverts', () => {
    const onChange = vi.fn();
    render(<MultiSelect title="Test" options={opts} selected={[]} onChange={onChange} defaultOpen />);
    fireEvent.change(screen.getByLabelText('Szukaj w: Test'), { target: { value: 'lodz' } });
    expect(screen.queryByLabelText(/Opcja 2/)).toBeNull();
    fireEvent.click(screen.getByText('Zaznacz wszystko'));
    expect(onChange).toHaveBeenLastCalledWith(['v3']);
    fireEvent.click(screen.getByText('Odwróć'));
    expect(onChange).toHaveBeenLastCalledWith(['v3']);
    fireEvent.click(screen.getByText('Wyczyść'));
    expect(onChange).toHaveBeenLastCalledWith([]);
  });

  it('keeps selected values that are not offered, so they can be unticked', () => {
    render(<MultiSelect title="Test" options={[]} selected={['gone']} onChange={() => {}} defaultOpen />);
    expect(screen.getByLabelText('gone')).toBeTruthy();
  });

  it('caps long lists and says so', () => {
    const many = Array.from({ length: 12 }, (_, i) => ({ value: String(i), label: `L${i}` }));
    render(<MultiSelect title="T" options={many} selected={[]} onChange={() => {}} cap={5} defaultOpen />);
    expect(screen.getByText(/Pokazano 5 z 12/)).toBeTruthy();
  });
});
