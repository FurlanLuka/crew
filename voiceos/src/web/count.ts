// The page's one plural rule: "1 project", "2 projects", "1 thing needs".
export const countOf = (count: number, singular: string, plural = `${singular}s`): string =>
	`${count} ${count === 1 ? singular : plural}`;
