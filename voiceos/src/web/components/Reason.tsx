import { type FormEvent, useState } from 'react';

interface ReasonProps {
	label: string;
	onSubmit: (message: string) => void;
}

export const Reason = ({ label, onSubmit }: ReasonProps) => {
	const [text, setText] = useState('');

	const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
		event.preventDefault();

		if (text.trim()) {
			onSubmit(text.trim());
		}
	};

	return (
		<form className="reason" onSubmit={handleSubmit}>
			<input
				value={text}
				onChange={(event) => setText(event.target.value)}
				placeholder={label}
				aria-label={label}
			/>
			<button className="btn" type="submit">
				Send
			</button>
		</form>
	);
};
