-- AddForeignKey
ALTER TABLE "section" ADD CONSTRAINT "section_campus_id_fkey" FOREIGN KEY ("campus_id") REFERENCES "campus"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
