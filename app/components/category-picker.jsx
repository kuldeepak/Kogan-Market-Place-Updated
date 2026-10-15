import { useEffect, useRef, useState } from "react";
import { useFetcher } from "react-router";

/**
 * Searchable list of Kogan categories. Calls `onSelect("kogan:<id>", path,
 * category)` when the merchant picks one.
 */
export function CategoryPicker({ currency, onSelect, actionLabel = "Use", selectedValue = null }) {
  const fetcher = useFetcher();
  const [query, setQuery] = useState("");
  const timer = useRef();

  useEffect(() => {
    clearTimeout(timer.current);
    if (query.trim().length < 2) return undefined;
    timer.current = setTimeout(() => {
      const params = new URLSearchParams({ q: query.trim() });
      if (currency) params.set("currency", currency);
      fetcher.load(`/api/kogan-categories?${params.toString()}`);
    }, 300);
    return () => clearTimeout(timer.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, currency]);

  const results = query.trim().length >= 2 ? fetcher.data?.results || [] : [];

  return (
    <s-stack gap="small">
      <s-search-field
        label="Find a Kogan category"
        placeholder="e.g. headphones, phone cases, 46114"
        onInput={(event) => setQuery(event.currentTarget.value)}
      />
      {fetcher.state === "loading" && (
        <s-stack direction="inline" gap="small-200" alignItems="center">
          <s-spinner size="base" accessibilityLabel="Loading categories" />
          <s-text color="subdued">Searching Kogan categories…</s-text>
        </s-stack>
      )}
      {fetcher.data?.error && <s-text tone="critical">{fetcher.data.error}</s-text>}
      {fetcher.state === "idle" &&
        query.trim().length >= 2 &&
        results.length === 0 &&
        !fetcher.data?.error &&
        fetcher.data && <s-text color="subdued">No categories match “{query}”.</s-text>}
      {results.length > 0 && (
        <s-box border="base" borderRadius="base" maxBlockSize="320px" overflow="hidden">
          <s-scroll-box maxBlockSize="320px">
            {results.map((category, index) => {
              const value = `kogan:${category.id}`;
              const selected = selectedValue === value;
              return (
                <s-box
                  key={category.id}
                  padding="small"
                  borderWidth={index === 0 ? undefined : "base none none none"}
                >
                  <s-stack direction="inline" justifyContent="space-between" alignItems="center" gap="base">
                    <s-stack gap="small-300">
                      <s-text type="strong">{category.title}</s-text>
                      <s-text color="subdued">
                        {category.display} · {value}
                        {category.departments?.length ? ` · ${category.departments.join(", ")}` : ""}
                      </s-text>
                    </s-stack>
                    <s-button
                      variant={selected ? "secondary" : undefined}
                      disabled={selected || undefined}
                      onClick={() => onSelect(value, category.display, category)}
                    >
                      {selected ? "Selected" : actionLabel}
                    </s-button>
                  </s-stack>
                </s-box>
              );
            })}
          </s-scroll-box>
        </s-box>
      )}
    </s-stack>
  );
}
