import type { ReactNode } from 'react';

interface CardProps {
	title: string;
	children: ReactNode;
}

export const Card = ({ title, children }: CardProps) => {
	return (
		<div className="card" role="alert">
			<h2>{title}</h2>
			{children}
		</div>
	);
};
